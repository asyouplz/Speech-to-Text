import { LiveSessionController } from '../../src/core/realtime/LiveSessionController';
import type { RealtimeSessionStore } from '../../src/infrastructure/storage/RealtimeSessionStore';
import { normalizeRealtimeSettings } from '../../src/core/realtime/types';

function fixture() {
    const store = {
        metadata: { mimeType: 'audio/webm' },
        create: jest.fn().mockResolvedValue(undefined),
        save: jest.fn().mockResolvedValue(undefined),
        finalizeAudio: jest.fn().mockResolvedValue('audio.webm'),
    };
    const microphone = {
        open: jest.fn().mockResolvedValue({}),
        capture: jest.fn().mockResolvedValue(undefined),
        flush: jest.fn().mockResolvedValue(true),
        close: jest.fn(),
    };
    const recorder = {
        start: jest.fn(),
        requestStop: jest.fn(),
        stop: jest.fn().mockResolvedValue(undefined),
        retrySave: jest.fn().mockResolvedValue(undefined),
    };
    const realtime = {
        connect: jest.fn().mockResolvedValue(undefined),
        append: jest.fn(),
        finish: jest.fn().mockResolvedValue({ text: 'final', complete: true }),
        close: jest.fn(),
    };
    const writer = jest.fn().mockResolvedValue(undefined);
    const run = new LiveSessionController(
        store as unknown as RealtimeSessionStore,
        microphone,
        recorder,
        realtime,
        1,
        jest.fn(),
        writer
    );
    return { run, store, microphone, recorder, realtime, writer };
}

describe('live session lifetime', () => {
    afterEach(() => jest.useRealTimers());
    test('does not record until microphone setup and server configuration are ready', async () => {
        const { run, realtime, recorder } = fixture();
        let ready!: () => void;
        realtime.connect.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    ready = resolve;
                })
        );
        const starting = run.start();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(recorder.start).not.toHaveBeenCalled();
        ready();
        await starting;
        expect(recorder.start).toHaveBeenCalledTimes(1);
        await run.stop();
    });

    test('overlapping stops share one finalization and clear the budget timer', async () => {
        jest.useFakeTimers();
        const { run, realtime, store } = fixture();
        await run.start();
        let finish!: (value: { text: string; complete: boolean }) => void;
        realtime.finish.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const ending = run.stop();
        expect(run.isActive).toBe(true);
        expect(run.stop()).toBe(ending);
        for (let i = 0; i < 8; i++) await Promise.resolve();
        await jest.advanceTimersByTimeAsync(120000);
        finish({ text: 'done', complete: true });
        await ending;
        expect(run.isActive).toBe(false);
        expect(realtime.finish).toHaveBeenCalledTimes(1);
        expect(store.finalizeAudio).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('disk failure still closes resources and permits saving again', async () => {
        const { run, store, microphone, realtime, recorder } = fixture();
        await run.start();
        store.finalizeAudio.mockRejectedValueOnce(new Error('disk full'));
        await run.stop();
        expect(microphone.close).toHaveBeenCalled();
        expect(realtime.close).toHaveBeenCalled();
        expect(run.snapshot.audioSaved).toBe(false);
        await run.retrySave();
        expect(recorder.retrySave).toHaveBeenCalledTimes(1);
        expect(run.snapshot.audioSaved).toBe(true);
    });

    test('unload preserves local audio without committing more network audio', async () => {
        const { run, realtime, recorder, store } = fixture();
        await run.start();
        await run.stop(true);
        expect(recorder.stop).toHaveBeenCalled();
        expect(store.finalizeAudio).toHaveBeenCalled();
        expect(realtime.finish).not.toHaveBeenCalled();
        expect(run.snapshot.complete).toBe(false);
    });

    test('cancelling pending microphone permission prevents a late recording start', async () => {
        const { run, microphone, recorder, realtime } = fixture();
        let grant!: (stream: object) => void;
        microphone.open.mockImplementation(
            () =>
                new Promise((resolve) => {
                    grant = resolve;
                })
        );
        const starting = run.start();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        await run.stop();
        grant({});
        await expect(starting).rejects.toThrow('cancelled');
        expect(recorder.start).not.toHaveBeenCalled();
        expect(realtime.connect).not.toHaveBeenCalled();
    });

    test('missing worklet acknowledgment prevents a false complete transcript', async () => {
        const { run, microphone } = fixture();
        await run.start();
        microphone.flush.mockResolvedValue(false);
        await run.stop();
        expect(run.snapshot.complete).toBe(false);
        expect(run.snapshot.audioSaved).toBe(true);
    });

    test('normalizes absent and malformed settings without enabling capture', () => {
        expect(normalizeRealtimeSettings(undefined).enabled).toBe(false);
        expect(
            normalizeRealtimeSettings({
                enabled: 'true',
                maxMinutes: Infinity,
                language: '../path',
            })
        ).toMatchObject({ enabled: false, maxMinutes: 45, language: 'ko' });
        expect(normalizeRealtimeSettings({ maxMinutes: 120 }).maxMinutes).toBe(55);
    });
});
