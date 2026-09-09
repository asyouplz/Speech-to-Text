import type { RealtimeResult, RealtimeTranscriber, SessionSnapshot } from './types';
import type { RealtimeSessionStore } from '../../infrastructure/storage/RealtimeSessionStore';

interface Microphone {
    open(): Promise<MediaStream>;
    capture(callback: (frame: Float32Array) => void): Promise<void>;
    flush(): Promise<boolean>;
    close(): void;
}

interface Recorder {
    start(stream: MediaStream, mimeType: string): void;
    requestStop(): void;
    stop(): Promise<void>;
    retrySave(): Promise<void>;
}

export type LiveSnapshot = Omit<SessionSnapshot, 'revision'>;

/** Owns one recording's lifetime; stop is single-flight, including timeout and unload paths. */
export class LiveSessionController {
    readonly snapshot: LiveSnapshot = {
        text: '',
        complete: false,
        status: 'Preparing (microphone not recording)',
        warning: '',
        finalText: '',
        audioSaved: false,
        postProcess: 'none',
    };
    private initializing: Promise<void> = Promise.resolve();
    private ending: Promise<void> | null = null;
    private finished = false;
    private cancelled = false;
    private interrupted = false;
    private transcriptIncomplete = false;
    private recording = false;
    private recorded = false;
    private timer: number | null = null;
    private checkpoint: Promise<void> | null = null;
    private startedAt = 0;

    constructor(
        readonly store: RealtimeSessionStore,
        private microphone: Microphone,
        private recorder: Recorder,
        private realtime: RealtimeTranscriber,
        private maxMinutes: number,
        private publish: (snapshot: LiveSnapshot) => void,
        private writeNote: (snapshot: LiveSnapshot) => Promise<void>,
        private onTimeLimit?: () => void
    ) {}

    get isActive(): boolean {
        return !this.finished;
    }
    get hasRecording(): boolean {
        return this.recorded;
    }

    async start(): Promise<void> {
        this.initializing = this.store.create();
        try {
            await this.initializing;
            this.assertActive();
            await this.store.save(this.snapshot);
            const stream = await this.microphone.open();
            this.assertActive();
            await this.microphone.capture((frame) => {
                if (this.recording) this.realtime.append(frame);
            });
            this.assertActive();
            await this.realtime.connect();
            this.assertActive();
            this.recorder.start(stream, this.store.metadata.mimeType);
            this.recorded = true;
            this.recording = true;
            this.startedAt = Date.now();
            this.snapshot.status = 'Recording and transcribing';
            this.timer = window.setInterval(() => {
                if (Date.now() - this.startedAt >= this.maxMinutes * 60000) {
                    if (this.onTimeLimit) this.onTimeLimit();
                    else void this.stop().catch(() => undefined);
                } else {
                    this.saveCheckpoint();
                }
            }, 1000);
            this.emit();
        } catch (error) {
            if (!this.cancelled) {
                this.snapshot.warning =
                    'Live transcription could not start. Check microphone access and OpenAI settings.';
                await this.interrupt();
            }
            throw error;
        }
    }

    private assertActive(): void {
        if (this.cancelled) throw new Error('Recording start was cancelled');
    }

    receiveText(text: string): void {
        this.snapshot.text = text;
        this.emit();
    }

    disconnected(): void {
        if (this.cancelled) return;
        // recording describes local capture. The closed live adapter ignores further PCM frames.
        this.transcriptIncomplete = true;
        const seconds = this.startedAt
            ? Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000))
            : 0;
        this.snapshot.warning = [
            this.snapshot.warning,
            `Live transcription disconnected around ${seconds}s into the recording. Later audio is only in the local recording.`,
        ]
            .filter(Boolean)
            .join('\n');
        if (this.recording) this.snapshot.status = 'Recording locally; live text interrupted';
        this.emit();
    }

    recordingSizeWarning(): boolean {
        if (this.cancelled) return false;
        const warning =
            'Recording has reached 48 MiB and is approaching the 64 MiB save limit. Stop and save soon.';
        this.snapshot.warning = [this.snapshot.warning, warning].filter(Boolean).join('\n');
        this.emit();
        return true;
    }

    recordingFailed(): void {
        this.snapshot.warning =
            'Recording or storage was interrupted. Use Retry saving before starting another session.';
        // Stop intake, but let the live provider finish audio it has already received.
        void this.stop().catch(() => undefined);
    }

    stop(): Promise<void> {
        if (this.ending) return this.ending;
        this.cancelled = true;
        if (this.timer) window.clearInterval(this.timer);
        this.timer = null;
        if (!this.recording || this.interrupted) {
            this.realtime.close();
            this.recorder.requestStop();
            this.microphone.close();
        }
        this.ending = this.finish();
        return this.ending;
    }

    /** Explicit shutdown may interrupt an existing drain; a storage failure must not. */
    interrupt(): Promise<void> {
        this.interrupted = true;
        this.realtime.close();
        this.recorder.requestStop();
        this.microphone.close();
        return this.stop();
    }

    private async finish(): Promise<void> {
        this.snapshot.status = 'Saving recording and waiting for final text';
        this.emit();
        try {
            await this.initializing;
            if (this.recording && !this.interrupted) {
                const flushed = await this.microphone.flush();
                if (!flushed) {
                    this.transcriptIncomplete = true;
                    this.snapshot.warning =
                        'The last live audio frame was not acknowledged; check the recording.';
                }
            }
            this.recording = false;
            this.recorder.requestStop();
            this.microphone.close();
            const audio = this.recorder.stop().then(async () => {
                if (!this.recorded) return;
                await this.store.finalizeAudio();
                this.snapshot.audioSaved = true;
            });
            const transcript: Promise<RealtimeResult> = this.interrupted
                ? Promise.resolve({ text: this.snapshot.text, complete: false })
                : this.realtime.finish();
            const [saved, result] = await Promise.allSettled([audio, transcript]);
            if (result.status === 'fulfilled') {
                this.snapshot.text = result.value.text;
                this.snapshot.complete =
                    result.value.complete && !this.transcriptIncomplete && !this.interrupted;
            }
            if (saved.status === 'rejected') {
                this.snapshot.warning =
                    'Audio assembly did not finish. Saved chunks and any unsaved chunks in memory have been retained. Use Retry saving.';
            } else if (!this.snapshot.complete && !this.snapshot.warning) {
                this.snapshot.warning =
                    'Live text is incomplete. The local recording is available for recovery or speaker transcription.';
            }
            const status = !this.recorded
                ? 'Stopped before recording'
                : this.snapshot.audioSaved
                ? 'Recording saved'
                : 'Save needs attention';
            await this.checkpoint;
            await this.persistOutput(status);
        } catch {
            await this.markSaveFailure();
        } finally {
            this.finished = true;
            this.recording = false;
            this.recorder.requestStop();
            this.microphone.close();
            this.realtime.close();
            this.emit();
        }
    }

    async retrySave(): Promise<void> {
        if (!this.ending) throw new Error('Stop recording before retrying a save');
        await this.ending;
        if (this.snapshot.status !== 'Save needs attention') return;
        try {
            await this.recorder.retrySave();
            await this.store.finalizeAudio();
            this.snapshot.audioSaved = true;
            await this.persistOutput('Recording saved');
        } catch (error) {
            await this.markSaveFailure();
            throw error;
        } finally {
            this.emit();
        }
    }

    private async persistOutput(status: string): Promise<void> {
        const saved = { ...this.snapshot, status };
        // Publish success only after both outputs succeed. Note writes are idempotent on retry.
        await this.writeNote(saved);
        await this.store.save(saved);
        this.snapshot.status = status;
    }

    private async markSaveFailure(): Promise<void> {
        this.snapshot.status = 'Save needs attention';
        this.snapshot.warning =
            'Some output could not be saved. Keep this session open and use Retry saving.';
        // The state disk may be the failing resource. Keep the in-memory retry state regardless.
        await this.store.save(this.snapshot).catch(() => undefined);
    }

    private saveCheckpoint(): void {
        if (this.checkpoint || this.cancelled) return;
        this.checkpoint = this.store
            .save(this.snapshot)
            .catch(() => {
                this.snapshot.warning =
                    'A transcript checkpoint could not be saved; the session is stopping to save its output.';
                void this.stop().catch(() => undefined);
            })
            .finally(() => {
                this.checkpoint = null;
            });
    }

    private emit(): void {
        this.publish({ ...this.snapshot });
    }
}
