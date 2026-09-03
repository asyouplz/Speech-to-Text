import { requestUrl } from 'obsidian';
import { DeepgramService } from '../../src/infrastructure/api/providers/deepgram/DeepgramService';
import { RealtimePostProcessor } from '../../src/core/realtime/RealtimePostProcessor';

test('cancellation during Deepgram backoff prevents another upload', async () => {
    jest.useFakeTimers();
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const service = new DeepgramService('key', logger);
    const controller = new AbortController();
    const bytes = new Uint8Array(2048);
    bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
    (requestUrl as jest.Mock).mockRejectedValue(new Error('network disconnected'));
    const promise = service.transcribe(bytes.buffer, {}, 'ko', controller.signal);
    const rejected = expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    await jest.advanceTimersByTimeAsync(0);
    expect(requestUrl).toHaveBeenCalledTimes(1);
    controller.abort();
    await jest.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(requestUrl).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
});

test('speaker postprocessing rejects an invalid container before contacting a provider', async () => {
    await expect(
        new RealtimePostProcessor().transcribe(new ArrayBuffer(32), 'key', 'ko')
    ).rejects.toThrow('WebM');
    expect(requestUrl).not.toHaveBeenCalled();
});

test('speaker postprocessing sends Korean Nova-3 and a complete WebM container', async () => {
    const bytes = new Uint8Array(2048);
    bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
    (requestUrl as jest.Mock).mockResolvedValue({
        status: 200,
        headers: {},
        json: {
            metadata: { duration: 1, channels: 1, models: ['nova-3'] },
            results: {
                channels: [
                    {
                        alternatives: [
                            {
                                transcript: '안녕하세요',
                                confidence: 0.99,
                                words: [
                                    {
                                        word: '안녕하세요',
                                        start: 0,
                                        end: 1,
                                        confidence: 0.99,
                                        speaker: 0,
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        },
    });
    const result = await new RealtimePostProcessor().transcribe(bytes.buffer, 'key', 'ko');
    const request = (requestUrl as jest.Mock).mock.calls[0][0];
    const url = new URL(request.url);
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.has('tier')).toBe(false);
    expect(url.searchParams.get('language')).toBe('ko');
    expect(url.searchParams.get('diarize')).toBe('true');
    expect(request.headers['Content-Type']).toBe('audio/webm');
    expect(request.body).toBe(bytes.buffer);
    expect(result.provider).toBe('deepgram');
    expect(result.segments?.[0].speaker).toBeDefined();
});
