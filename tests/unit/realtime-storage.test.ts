import {
    RealtimeSessionStore,
    SESSION_ROOT,
} from '../../src/infrastructure/storage/RealtimeSessionStore';
import { LocalRecorder } from '../../src/infrastructure/audio/LocalRecorder';
import type { LiveSnapshot } from '../../src/core/realtime/LiveSessionController';
import { Blob as NodeBlob } from 'buffer';

export function storageFixture() {
    const files = new Map<string, string | ArrayBuffer>();
    const folders = new Set<string>();
    const adapter = {
        exists: jest.fn(async (path: string) => files.has(path) || folders.has(path)),
        mkdir: jest.fn(async (path: string) => {
            folders.add(path);
        }),
        write: jest.fn(async (path: string, text: string) => {
            files.set(path, text);
        }),
        read: jest.fn(async (path: string) => {
            if (!files.has(path)) throw new Error('missing');
            return files.get(path) as string;
        }),
        writeBinary: jest.fn(async (path: string, bytes: ArrayBuffer) => {
            files.set(path, bytes);
        }),
        readBinary: jest.fn(async (path: string) => files.get(path) as ArrayBuffer),
        rename: jest.fn(async (from: string, to: string) => {
            files.set(to, files.get(from)!);
            files.delete(from);
        }),
        list: jest.fn(async (path: string) => ({
            files: [...files.keys()].filter(
                (p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/')
            ),
            folders: [...folders].filter(
                (p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/')
            ),
        })),
    };
    const metadata = {
        id: 'test-session',
        startedAt: '2026-09-03T00:00:00Z',
        mimeType: 'audio/webm;codecs=opus',
        notePath: `${SESSION_ROOT}/test-session/transcript.md`,
    };
    return {
        files,
        folders,
        adapter,
        store: new RealtimeSessionStore(adapter, metadata),
        metadata,
    };
}

const state: LiveSnapshot = {
    text: 'first',
    complete: false,
    status: 'Recording',
    warning: '',
    finalText: '',
    audioSaved: false,
    postProcess: 'none',
};
const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2]).buffer;

describe('durable recording storage', () => {
    test('retains ordered chunks across a failed final write and reconstructs them on restart', async () => {
        const { store, adapter, files, metadata } = storageFixture();
        await store.create();
        await store.writeChunk(0, bytes);
        await store.writeChunk(1, new Uint8Array([3, 4]).buffer);
        adapter.writeBinary.mockRejectedValueOnce(new Error('disk full'));
        await expect(store.finalizeAudio()).rejects.toThrow('disk full');
        expect([...files.keys()].filter((p) => p.endsWith('.part'))).toHaveLength(2);
        const restored = new RealtimeSessionStore(adapter, metadata);
        await restored.finalizeAudio();
        expect(new Uint8Array(files.get(store.audioPath) as ArrayBuffer)).toEqual(
            new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])
        );
    });

    test('does not concatenate across a missing chunk or include an interrupted pending write', async () => {
        const { store, files } = storageFixture();
        await store.create();
        await store.writeChunk(0, bytes);
        await store.writeChunk(2, bytes);
        files.set(`${store.folder}/audio-000001.part.pending`, bytes);
        await expect(store.finalizeAudio()).rejects.toThrow('missing');
        expect(files.has(store.audioPath)).toBe(false);
    });

    test('retrying a committed chunk is idempotent and rejects conflicting content', async () => {
        const { store, adapter } = storageFixture();
        await store.create();
        await store.writeChunk(0, bytes);
        await store.writeChunk(0, bytes);
        expect(adapter.rename).toHaveBeenCalledTimes(1);
        await expect(store.writeChunk(0, new Uint8Array([99]).buffer)).rejects.toThrow('different');
    });

    test('repeated checkpoint failures never overwrite the last valid checkpoint slot', async () => {
        const { store, files, adapter, metadata } = storageFixture();
        await store.create();
        await store.save(state);
        adapter.write.mockImplementation(async (path) => {
            files.set(path, '{broken');
            throw new Error('interrupted');
        });
        await expect(store.save({ ...state, text: 'second' })).rejects.toThrow();
        await expect(store.save({ ...state, text: 'third' })).rejects.toThrow();
        const restored = new RealtimeSessionStore(adapter, metadata);
        expect((await restored.load())?.text).toBe('first');
    });

    test('ignores a session descriptor that points outside its own folder', async () => {
        const { store, adapter, files, metadata } = storageFixture();
        await store.create();
        files.set(
            `${store.folder}/session.json`,
            JSON.stringify({ ...metadata, notePath: '../private.md' })
        );
        expect(await RealtimeSessionStore.list(adapter)).toEqual([]);
    });
});

function recorderFixture(write: (index: number, bytes: ArrayBuffer) => Promise<void>) {
    const fake = {
        state: 'inactive',
        ondataavailable: null as null | ((event: { data: Blob }) => void),
        onstop: null as null | (() => void),
        onerror: null as null | (() => void),
        start: jest.fn(() => {
            fake.state = 'recording';
        }),
        stop: jest.fn(() => {
            fake.state = 'inactive';
            queueMicrotask(() => fake.onstop?.());
        }),
    };
    const failed = jest.fn();
    const recorder = new LocalRecorder(write, failed, () => fake as unknown as MediaRecorder);
    recorder.start({} as MediaStream, 'audio/webm');
    return { recorder, fake, failed };
}

describe('local recorder', () => {
    test('persists a chunk while recording is still running', async () => {
        const done: ArrayBuffer[] = [];
        let persisted!: () => void;
        const wrote = new Promise<void>((resolve) => {
            persisted = resolve;
        });
        const { recorder, fake } = recorderFixture(async (_, data) => {
            done.push(data);
            persisted();
        });
        fake.ondataavailable?.({ data: new NodeBlob([bytes]) as unknown as Blob });
        await wrote;
        expect(fake.state).toBe('recording');
        expect(done[0]).toEqual(bytes);
        await recorder.stop();
    });

    test('stops intake on disk failure, retains the blob, and saves it on retry', async () => {
        const write = jest
            .fn()
            .mockRejectedValueOnce(new Error('disk full'))
            .mockResolvedValue(undefined);
        const { recorder, fake } = recorderFixture(write);
        fake.ondataavailable?.({ data: new NodeBlob([bytes]) as unknown as Blob });
        await expect(recorder.stop()).rejects.toThrow('retry');
        await recorder.retrySave();
        expect(write).toHaveBeenLastCalledWith(0, bytes);
        expect(fake.stop).toHaveBeenCalledTimes(1);
    });
});
