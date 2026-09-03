type RecorderFactory = (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;

/** Each MediaRecorder event is persisted immediately, independently of final file assembly. */
export class LocalRecorder {
    private recorder: MediaRecorder | null = null;
    private pending = new Map<number, Blob>();
    private index = 0;
    private writes: Promise<void> = Promise.resolve();
    private stopped: Promise<void> = Promise.resolve();
    private stopRequested = false;
    private failure: unknown;

    constructor(
        private writeChunk: (index: number, bytes: ArrayBuffer) => Promise<void>,
        private onFailure: () => void,
        private factory: RecorderFactory = (stream, options) => new MediaRecorder(stream, options)
    ) {}

    start(stream: MediaStream, mimeType: string): void {
        if (this.recorder) throw new Error('Recording has already started');
        const recorder = this.factory(stream, { mimeType, audioBitsPerSecond: 64000 });
        this.recorder = recorder;
        this.stopped = new Promise((resolve) => {
            recorder.onstop = () => {
                resolve();
                if (!this.stopRequested) {
                    this.failure = new Error('Microphone recording ended unexpectedly');
                    this.onFailure();
                }
            };
        });
        recorder.ondataavailable = (event) => {
            if (!event.data.size) return;
            this.pending.set(this.index++, event.data);
            this.enqueueWrites();
            if (
                [...this.pending.values()].reduce((size, blob) => size + blob.size, 0) >
                8 * 1024 * 1024
            ) {
                this.failure = new Error('Recording storage is not keeping up');
                this.requestStop();
                this.onFailure();
            }
        };
        recorder.onerror = () => {
            this.failure = new Error('Microphone recording was interrupted');
            this.onFailure();
        };
        try {
            recorder.start(5000);
        } catch (error) {
            this.stopped = Promise.resolve();
            this.recorder = null;
            throw error;
        }
    }

    private enqueueWrites(): void {
        this.writes = this.writes.then(async () => {
            try {
                for (const [index, blob] of this.pending) {
                    await this.writeChunk(index, await blob.arrayBuffer());
                    this.pending.delete(index);
                }
            } catch (error) {
                this.failure = error;
                // Stop intake on storage failure, bounding RAM while retaining failed chunks.
                this.requestStop();
                this.onFailure();
            }
        });
    }

    requestStop(): void {
        if (this.stopRequested) return;
        this.stopRequested = true;
        try {
            if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
        } catch (error) {
            this.failure = error;
            this.stopped = Promise.resolve();
        }
    }

    async stop(): Promise<void> {
        this.requestStop();
        await this.waitForStop();
        await this.writes;
        if (this.failure)
            throw new Error('Recording was interrupted; retry saving retained chunks');
    }

    async retrySave(): Promise<void> {
        this.requestStop();
        await this.waitForStop();
        await this.writes;
        this.failure = undefined;
        this.enqueueWrites();
        await this.writes;
        if (this.failure)
            throw new Error('Could not save recording chunks; they are still retained');
    }

    private async waitForStop(): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.stopped,
                new Promise<void>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error('Recording stop is still pending; retry saving shortly')
                            ),
                        3000
                    );
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}
