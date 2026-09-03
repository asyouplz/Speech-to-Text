import { requestUrl } from 'obsidian';
import { TranscriptAssembler } from '../../src/infrastructure/api/providers/realtime/TranscriptAssembler';
import { OpenAIRealtimeTranscriber } from '../../src/infrastructure/api/providers/realtime/OpenAIRealtimeTranscriber';
import { issueRealtimeProtocols } from '../../src/infrastructure/api/providers/realtime/RealtimeAuth';
import { DEFAULT_REALTIME_SETTINGS } from '../../src/core/realtime/types';
import { PCM_WORKLET_SOURCE } from '../../src/infrastructure/audio/pcmWorkletSource';
import { runInNewContext } from 'vm';

function fixture(authorize = jest.fn().mockResolvedValue(['realtime', 'temporary-token'])) {
    const ws = {
        readyState: 1,
        bufferedAmount: 0,
        send: jest.fn(),
        close: jest.fn(),
        onopen: null as null | (() => void),
        onmessage: null as null | ((event: { data: string }) => void),
        onclose: null as null | (() => void),
        onerror: null as null | (() => void),
    };
    const factory = jest.fn(() => ws as unknown as WebSocket);
    const disconnect = jest.fn();
    const client = new OpenAIRealtimeTranscriber(
        'key',
        DEFAULT_REALTIME_SETTINGS,
        jest.fn(),
        disconnect,
        factory,
        authorize
    );
    const event = (data: object) => ws.onmessage?.({ data: JSON.stringify(data) });
    const ready = async () => {
        const promise = client.connect();
        await Promise.resolve();
        ws.onopen?.();
        event({ type: 'session.updated', session: { type: 'transcription' } });
        await promise;
    };
    return { client, ws, factory, event, ready, disconnect };
}

describe('realtime protocol', () => {
    afterEach(() => jest.useRealTimers());

    test('a failed final transcription retains already received partial text', () => {
        const assembler = new TranscriptAssembler();
        assembler.register('one');
        assembler.update('one', 0, 'saved partial', false);
        assembler.update('one', 0, '', true, true);
        expect(assembler.text).toBe('saved partial');
        expect(assembler.complete).toBe(false);
    });

    test('orders completed and partial text by committed input, preserving content indexes', () => {
        const result = new TranscriptAssembler();
        result.register('first');
        result.register('second');
        result.update('second', 0, 'B', true);
        result.update('first', 1, 'A2', true);
        result.update('first', 0, 'A', false);
        result.update('first', 0, '1', false);
        expect(result.complete).toBe(false);
        result.update('first', 0, 'A1', true);
        result.update('first', 0, 'late delta', false);
        expect(result.text).toBe('A1\n\nA2\n\nB');
        expect(result.complete).toBe(true);
    });

    test('does not become ready merely because the socket opened', async () => {
        const { client, ws, event } = fixture();
        const connected = jest.fn();
        const promise = client.connect().then(connected);
        await Promise.resolve();
        ws.onopen?.();
        await Promise.resolve();
        expect(connected).not.toHaveBeenCalled();
        client.append(new Float32Array(2400));
        expect(ws.send).toHaveBeenCalledTimes(1);
        event({ type: 'session.updated', session: { type: 'transcription' } });
        await promise;
        expect(connected).toHaveBeenCalledTimes(1);
        client.close();
    });

    test('cancelling during token issuance cannot open a socket later', async () => {
        let authorize!: (value: string[]) => void;
        const { client, factory } = fixture(
            jest.fn(
                () =>
                    new Promise<string[]>((resolve) => {
                        authorize = resolve;
                    })
            )
        );
        const promise = client.connect();
        client.close();
        await expect(promise).rejects.toThrow();
        authorize(['late-token']);
        await Promise.resolve();
        expect(factory).not.toHaveBeenCalled();
    });

    test('401 fails authorization without returning the original API key', async () => {
        (requestUrl as jest.Mock).mockResolvedValueOnce({ status: 401, json: {} });
        await expect(issueRealtimeProtocols('original-key', {})).rejects.toThrow('401');
    });

    test('waits for actual final events and shares a single finish operation', async () => {
        const { client, ws, ready, event } = fixture();
        await ready();
        client.append(new Float32Array(128));
        const finish = client.finish();
        expect(client.finish()).toBe(finish);
        const done = jest.fn();
        void finish.then(done);
        event({ type: 'input_audio_buffer.committed', item_id: 'one' });
        await Promise.resolve();
        expect(done).not.toHaveBeenCalled();
        event({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'one',
            content_index: 0,
            transcript: 'final',
        });
        await expect(finish).resolves.toEqual({ text: 'final', complete: true });
        const messages = ws.send.mock.calls.map(([value]) => JSON.parse(value));
        expect(messages.filter((v) => v.type === 'input_audio_buffer.commit')).toHaveLength(1);
        expect(messages.filter((v) => v.type === 'input_audio_buffer.append')).toHaveLength(2);
    });

    test('a final event timeout returns partial text with incomplete status', async () => {
        jest.useFakeTimers();
        const { client, ready, event } = fixture();
        await ready();
        client.append(new Float32Array(2400));
        event({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: 'one',
            content_index: 0,
            delta: 'partial',
        });
        const finish = client.finish();
        event({ type: 'input_audio_buffer.committed', item_id: 'one' });
        await jest.advanceTimersByTimeAsync(10000);
        await expect(finish).resolves.toEqual({ text: 'partial', complete: false });
    });

    test('socket backpressure stops transmission and reports a gap without reconnecting', async () => {
        const { client, ws, ready, disconnect, factory } = fixture();
        await ready();
        ws.bufferedAmount = 128001;
        client.append(new Float32Array(2400));
        client.append(new Float32Array(2400));
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(ws.send).toHaveBeenCalledTimes(1);
        await expect(client.finish()).resolves.toMatchObject({ complete: false });
    });

    test('a server configuration error rejects connection instead of silently recording', async () => {
        const { client, ws, event } = fixture();
        const pending = client.connect();
        await Promise.resolve();
        ws.onopen?.();
        event({ type: 'error', error: { message: 'invalid configuration' } });
        await expect(pending).rejects.toThrow('configured');
    });

    test('worklet flush emits every sample of a short final frame before its acknowledgment', () => {
        const output: unknown[] = [];
        let Processor: any;
        class Base {
            port = { postMessage: (data: unknown) => output.push(data), onmessage: null };
        }
        runInNewContext(PCM_WORKLET_SOURCE, {
            AudioWorkletProcessor: Base,
            registerProcessor: (_: string, value: unknown) => {
                Processor = value;
            },
            Float32Array,
        });
        const processor = new Processor();
        processor.process([[new Float32Array(128).fill(0.5)]]);
        processor.port.onmessage({ data: 'flush' });
        expect(output[0]).toEqual(new Float32Array(128).fill(0.5));
        expect(output[1]).toBe('flushed');
        expect(processor.process([[new Float32Array(128)]])).toBe(false);
    });
});
