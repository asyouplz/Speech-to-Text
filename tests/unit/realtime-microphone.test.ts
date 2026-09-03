import { MicrophoneCapture } from '../../src/infrastructure/audio/MicrophoneCapture';
import { LocalRecorder } from '../../src/infrastructure/audio/LocalRecorder';

describe('microphone resource boundaries', () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const contextDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
    afterEach(() => {
        for (const [name, descriptor] of [
            ['navigator', navigatorDescriptor],
            ['AudioContext', contextDescriptor],
        ] as const) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });

    test('stops a stream granted after cancellation without retaining microphone access', async () => {
        let grant!: (stream: MediaStream) => void;
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                mediaDevices: {
                    getUserMedia: () =>
                        new Promise<MediaStream>((resolve) => {
                            grant = resolve;
                        }),
                },
            },
        });
        const stop = jest.fn();
        const microphone = new MicrophoneCapture();
        const opening = microphone.open();
        microphone.close();
        grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
        await expect(opening).rejects.toThrow('cancelled');
        expect(stop).toHaveBeenCalledTimes(1);
    });

    test('rejects an ignored sample rate and releases the microphone and audio context on cleanup', async () => {
        const stop = jest.fn();
        const close = jest.fn().mockResolvedValue(undefined);
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
            },
        });
        Object.defineProperty(globalThis, 'AudioContext', {
            configurable: true,
            value: jest.fn(() => ({ sampleRate: 48000, close })),
        });
        const microphone = new MicrophoneCapture();
        await microphone.open();
        await expect(microphone.capture(jest.fn())).rejects.toThrow('24 kHz');
        microphone.close();
        expect(stop).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    test('a synchronous MediaRecorder start failure does not leave shutdown waiting forever', async () => {
        const fake = {
            state: 'inactive',
            start: () => {
                throw new Error('unsupported');
            },
        };
        const recorder = new LocalRecorder(
            jest.fn(),
            jest.fn(),
            () => fake as unknown as MediaRecorder
        );
        expect(() => recorder.start({} as MediaStream, 'audio/webm')).toThrow('unsupported');
        await expect(recorder.stop()).resolves.toBeUndefined();
    });
});
