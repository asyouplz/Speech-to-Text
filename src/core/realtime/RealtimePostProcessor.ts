import { DeepgramService } from '../../infrastructure/api/providers/deepgram/DeepgramService';
import { DEFAULT_DIARIZATION_CONFIG } from '../../infrastructure/api/providers/deepgram/DiarizationFormatter';
import type { TranscriptionResponse } from '../../infrastructure/api/providers/ITranscriber';
import type { ILogger } from '../../types';

/** Uses Deepgram directly, so missing credentials cannot silently select another provider. */
export class RealtimePostProcessor {
    private provider: DeepgramService | null = null;
    private abortController = new AbortController();

    async transcribe(
        audio: ArrayBuffer,
        apiKey: string,
        language: string
    ): Promise<TranscriptionResponse> {
        if (!apiKey.trim()) throw new Error('Set a Deepgram API key before speaker transcription');
        if (audio.byteLength < 4 || audio.byteLength > 64 * 1024 * 1024) {
            throw new Error('Recording is empty or exceeds the 64 MB limit');
        }
        const header = new Uint8Array(audio, 0, 4);
        if (header[0] !== 0x1a || header[1] !== 0x45 || header[2] !== 0xdf || header[3] !== 0xa3) {
            throw new Error('Only the saved WebM recording can be used for speaker transcription');
        }
        // The legacy service logs transcript excerpts. This path intentionally omits payload logs.
        const logger: ILogger = {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
        };
        this.provider = new DeepgramService(apiKey, logger, 100, 120000);
        // Submit the WebM container intact, without the batch adapter's byte-level chunking.
        const response = await this.provider.transcribe(
            audio,
            {
                model: 'nova-3',
                diarize: true,
                utterances: true,
                punctuate: true,
                smartFormat: true,
            },
            language,
            this.abortController.signal
        );
        return this.provider.parseResponse(response, {
            ...DEFAULT_DIARIZATION_CONFIG,
            enabled: true,
        });
    }

    cancel(): void {
        this.abortController.abort();
        this.provider?.cancel();
    }
}
