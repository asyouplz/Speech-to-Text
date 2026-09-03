import type {
    RealtimeResult,
    RealtimeSettings,
    RealtimeTranscriber,
} from '../../../../core/realtime/types';
import { floatToBase64Pcm16 } from '../../../audio/PcmEncoder';
import { issueRealtimeProtocols, RealtimeAuthorizationError } from './RealtimeAuth';
import { TranscriptAssembler } from './TranscriptAssembler';

type SocketFactory = (url: string, protocols: string[]) => WebSocket;

/** One connection per recording. A disconnect is visible and leaves local recording running. */
export class OpenAIRealtimeTranscriber implements RealtimeTranscriber {
    private socket: WebSocket | null = null;
    private closed = false;
    private ready = false;
    private failed = false;
    private samples = 0;
    private commits = 0;
    private assembler = new TranscriptAssembler();
    private rejectConnect: ((error: Error) => void) | null = null;
    private finishPromise: Promise<RealtimeResult> | null = null;
    private checkFinished: (() => void) | null = null;

    constructor(
        private apiKey: string,
        private settings: RealtimeSettings,
        private onText: (text: string) => void,
        private onDisconnect: () => void,
        private socketFactory: SocketFactory = (url, protocols) => new WebSocket(url, protocols),
        private authorize = issueRealtimeProtocols
    ) {}

    connect(): Promise<void> {
        const session = {
            type: 'transcription',
            audio: {
                input: {
                    format: { type: 'audio/pcm', rate: 24000 },
                    transcription: {
                        model: 'gpt-live-transcribe',
                        languages: [this.settings.language],
                        prompt: this.settings.prompt,
                        delay: 'low',
                    },
                    // Fixed input turns make final draining and ordering explicit.
                    turn_detection: null,
                },
            },
        };
        return new Promise((resolve, reject) => {
            if (this.closed || this.socket || this.rejectConnect) {
                reject(new Error('This live connection has already been used'));
                return;
            }
            const timer = setTimeout(() => this.fail(), 15000);
            this.rejectConnect = (error) => {
                clearTimeout(timer);
                this.rejectConnect = null;
                reject(error);
            };
            void this.authorize(this.apiKey, session)
                .then((protocols) => {
                    if (this.closed) return;
                    const ws = this.socketFactory(
                        'wss://api.openai.com/v1/realtime?intent=transcription',
                        protocols
                    );
                    this.socket = ws;
                    ws.onopen = () => {
                        if (this.closed) return;
                        this.send({ type: 'session.update', session });
                    };
                    ws.onmessage = (message: MessageEvent<unknown>) => {
                        if (this.closed || typeof message.data !== 'string') return;
                        try {
                            const parsed: unknown = JSON.parse(message.data);
                            if (!parsed || typeof parsed !== 'object') return;
                            const event = parsed as Record<string, unknown>;
                            if (event.type === 'session.updated' && !this.ready) {
                                const ack = event.session as { type?: unknown } | undefined;
                                if (ack?.type !== 'transcription') return;
                                this.ready = true;
                                clearTimeout(timer);
                                this.rejectConnect = null;
                                resolve();
                            } else if (event.type === 'error') {
                                this.fail();
                            } else {
                                this.handleEvent(event);
                            }
                        } catch {
                            this.fail();
                        }
                    };
                    ws.onerror = () => this.fail();
                    ws.onclose = () => {
                        if (!this.closed) this.fail();
                    };
                })
                .catch((error: unknown) =>
                    this.fail(error instanceof RealtimeAuthorizationError ? error : undefined)
                );
        });
    }

    append(samples: Float32Array): void {
        if (!this.ready || this.closed || this.finishPromise) return;
        // Bound browser-owned queued audio to approximately two seconds of PCM/base64.
        if (!this.socket || this.socket.bufferedAmount > 128000) {
            this.fail();
            return;
        }
        if (!this.send({ type: 'input_audio_buffer.append', audio: floatToBase64Pcm16(samples) }))
            return;
        this.samples += samples.length;
        if (this.samples >= 15 * 24000) this.commit();
    }

    private commit(): void {
        if (!this.samples || this.closed) return;
        // The server requires at least 100 ms per manual commit. Preserve a short tail with padding.
        if (this.samples < 2400) {
            this.send({
                type: 'input_audio_buffer.append',
                audio: floatToBase64Pcm16(new Float32Array(2400 - this.samples)),
            });
        }
        this.commits++;
        this.samples = 0;
        this.send({ type: 'input_audio_buffer.commit' });
    }

    private handleEvent(event: Record<string, unknown>): void {
        if (event.type === 'input_audio_buffer.committed' && typeof event.item_id === 'string') {
            this.assembler.register(event.item_id);
            this.commits = Math.max(0, this.commits - 1);
        } else if (
            typeof event.type === 'string' &&
            event.type.startsWith('conversation.item.input_audio_transcription.') &&
            typeof event.item_id === 'string' &&
            Number.isInteger(event.content_index) &&
            typeof event.content_index === 'number' &&
            event.content_index >= 0
        ) {
            if (event.type.endsWith('.delta') && typeof event.delta === 'string') {
                this.assembler.update(event.item_id, event.content_index, event.delta, false);
            } else if (event.type.endsWith('.completed') && typeof event.transcript === 'string') {
                this.assembler.update(event.item_id, event.content_index, event.transcript, true);
            } else if (event.type.endsWith('.failed')) {
                this.assembler.update(event.item_id, event.content_index, '', true, true);
                this.fail();
            }
        }
        this.onText(this.assembler.text);
        this.checkFinished?.();
    }

    finish(): Promise<RealtimeResult> {
        if (this.finishPromise) return this.finishPromise;
        this.commit();
        this.finishPromise = new Promise((resolve) => {
            const settle = (complete: boolean) => {
                clearTimeout(timer);
                this.checkFinished = null;
                this.close();
                resolve({ text: this.assembler.text, complete });
            };
            const timer = setTimeout(() => settle(false), 10000);
            this.checkFinished = () => {
                if (this.closed || this.failed) settle(false);
                else if (!this.commits && this.assembler.complete) settle(true);
            };
            this.checkFinished();
        });
        return this.finishPromise;
    }

    private send(payload: unknown): boolean {
        try {
            if (!this.socket || this.socket.readyState !== 1) throw new Error('Socket is closed');
            this.socket.send(JSON.stringify(payload));
            return true;
        } catch {
            this.fail();
            return false;
        }
    }

    private fail(error?: Error): void {
        if (this.closed) return;
        this.failed = true;
        if (error) this.rejectConnect?.(error);
        this.close();
        this.onDisconnect();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.ready = false;
        this.rejectConnect?.(new Error('Live connection could not be authorized or configured'));
        this.socket?.close();
        this.checkFinished?.();
    }
}
