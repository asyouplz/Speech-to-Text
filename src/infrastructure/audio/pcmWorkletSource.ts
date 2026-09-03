export const PCM_WORKLET_NAME = 'speechnote-pcm-capture';

/** Embedded because Obsidian loads a single main.js. Executed directly by a regression test. */
export const PCM_WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Float32Array(2400);
        this.offset = 0;
        this.stopped = false;
        this.port.onmessage = (event) => {
            if (event.data === 'flush') {
                this.stopped = true;
                if (this.offset) this.emit(this.buffer.slice(0, this.offset));
                this.offset = 0;
                this.port.postMessage('flushed');
            }
        };
    }
    emit(frame) { this.port.postMessage(frame, [frame.buffer]); }
    process(inputs) {
        if (this.stopped) return false;
        const channel = inputs[0] && inputs[0][0];
        if (!channel) return true;
        for (let i = 0; i < channel.length; i++) {
            this.buffer[this.offset++] = channel[i];
            if (this.offset === this.buffer.length) {
                this.emit(this.buffer.slice());
                this.offset = 0;
            }
        }
        return true;
    }
}
registerProcessor('${PCM_WORKLET_NAME}', PcmCaptureProcessor);
`;
