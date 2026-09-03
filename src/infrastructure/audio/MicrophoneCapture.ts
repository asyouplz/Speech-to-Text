import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from './pcmWorkletSource';

export class MicrophoneCapture {
    private context: AudioContext | null = null;
    private node: AudioWorkletNode | null = null;
    private stream: MediaStream | null = null;
    private closed = false;
    private flushed: (() => void) | null = null;

    async open(): Promise<MediaStream> {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
        if (this.closed) {
            stream.getTracks().forEach((track) => track.stop());
            throw new Error('Microphone start was cancelled');
        }
        this.stream = stream;
        return stream;
    }

    async capture(onFrame: (frame: Float32Array) => void): Promise<void> {
        if (this.closed || !this.stream) throw new Error('Microphone is not open');
        const context = new AudioContext({ sampleRate: 24000 });
        this.context = context;
        if (context.sampleRate !== 24000)
            throw new Error('24 kHz microphone capture is unavailable');
        const url = URL.createObjectURL(
            new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' })
        );
        try {
            await context.audioWorklet.addModule(url);
        } finally {
            URL.revokeObjectURL(url);
        }
        if (this.closed) throw new Error('Microphone start was cancelled');
        const node = new AudioWorkletNode(context, PCM_WORKLET_NAME);
        this.node = node;
        node.port.onmessage = (event: MessageEvent<unknown>) => {
            if (event.data === 'flushed') this.flushed?.();
            else if (event.data instanceof Float32Array) onFrame(event.data);
        };
        const source = context.createMediaStreamSource(this.stream);
        const sink = context.createGain();
        sink.gain.value = 0;
        source.connect(node);
        node.connect(sink);
        sink.connect(context.destination);
        await context.resume();
        if (this.closed) throw new Error('Microphone start was cancelled');
    }

    flush(): Promise<boolean> {
        const node = this.node;
        if (!node || this.closed) return Promise.resolve(false);
        return new Promise((resolve) => {
            const finish = (success: boolean) => {
                clearTimeout(timer);
                this.flushed = null;
                resolve(success);
            };
            const timer = setTimeout(() => finish(false), 2000);
            this.flushed = () => finish(true);
            node.port.postMessage('flush');
        });
    }

    close(): void {
        this.closed = true;
        this.stream?.getTracks().forEach((track) => track.stop());
        this.node?.disconnect();
        if (this.node) this.node.port.onmessage = null;
        if (this.context && this.context.state !== 'closed')
            void this.context.close().catch(() => undefined);
    }
}
