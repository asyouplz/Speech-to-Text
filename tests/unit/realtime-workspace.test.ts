import { RealtimeWorkspace } from '../../src/application/RealtimeWorkspace';
import { RealtimePostProcessor } from '../../src/core/realtime/RealtimePostProcessor';
import { SessionNoteWriter } from '../../src/core/realtime/SessionNoteWriter';
import type { RealtimeSessionStore } from '../../src/infrastructure/storage/RealtimeSessionStore';
import { DEFAULT_SETTINGS } from '../../src/domain/models/Settings';
import type { Plugin } from 'obsidian';
import type { LiveSnapshot } from '../../src/core/realtime/LiveSessionController';
import { DEFAULT_REALTIME_SETTINGS } from '../../src/core/realtime/types';

function fixture() {
    const initial: LiveSnapshot = {
        text: 'original live text',
        complete: false,
        status: 'Interrupted',
        warning: '',
        finalText: '',
        audioSaved: false,
        postProcess: 'none',
    };
    let saved = { ...initial, revision: 1 };
    const store = {
        metadata: { id: 'test', notePath: 'Recordings/SpeechNote/test/transcript.md' },
        audioPath: 'Recordings/SpeechNote/test/recording.webm',
        load: jest.fn(async () => ({ ...saved })),
        save: jest.fn(async (value: LiveSnapshot) => {
            saved = { ...value, revision: saved.revision + 1 };
        }),
        finalizeAudio: jest.fn().mockResolvedValue('recording.webm'),
    };
    const leaf = { setViewState: jest.fn().mockResolvedValue(undefined) };
    const plugin = {
        registerView: jest.fn(),
        addCommand: jest.fn(),
        app: {
            workspace: {
                getLeavesOfType: jest.fn(() => [leaf]),
                revealLeaf: jest.fn().mockResolvedValue(undefined),
            },
            vault: { adapter: { readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(32)) } },
        },
    };
    const settings = { ...DEFAULT_SETTINGS, deepgramApiKey: 'current-key' };
    const writer = jest.spyOn(SessionNoteWriter.prototype, 'write').mockResolvedValue(undefined);
    const post = jest.spyOn(RealtimePostProcessor.prototype, 'transcribe').mockResolvedValue({
        provider: 'deepgram',
        text: 'speaker text',
        segments: [{ id: 0, start: 0, end: 1, text: 'speaker text', speaker: 'Speaker 1' }],
        metadata: { diarizationEnabled: true },
    });
    const workspace = new RealtimeWorkspace(plugin as unknown as Plugin, () => settings);
    return {
        workspace,
        store: store as unknown as RealtimeSessionStore,
        rawStore: store,
        post,
        writer,
        plugin,
        settings,
    };
}

describe('live workspace integration', () => {
    afterEach(() => jest.restoreAllMocks());

    test('a recovered note write failure is shown and Retry saving completes it without uploading', async () => {
        const { workspace, store, writer, post } = fixture();
        writer.mockRejectedValueOnce(new Error('note path is a folder'));
        await expect(workspace.recover(store)).rejects.toThrow('note path is a folder');
        expect(workspace.snapshot).toMatchObject({
            status: 'Save needs attention',
            audioSaved: true,
            text: 'original live text',
        });
        expect(await store.load()).toMatchObject({ status: 'Save needs attention' });
        await expect(workspace.processSpeakers()).rejects.toThrow('Retry saving');
        await workspace.retrySave();
        expect(writer).toHaveBeenCalledTimes(2);
        expect(workspace.snapshot?.status).toBe('Recovered saved recording');
        expect(post).not.toHaveBeenCalled();
    });

    test('recovery success is persisted only after the note is written', async () => {
        const { workspace, store, writer } = fixture();
        let write!: () => void;
        writer.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    write = resolve;
                })
        );
        const recovery = workspace.recover(store);
        for (let i = 0; i < 12; i++) await Promise.resolve();
        expect((await store.load())?.audioSaved).toBe(false);
        expect(workspace.snapshot?.status).toBe('Recovering saved recording');
        write();
        await recovery;
        expect(await store.load()).toMatchObject({
            audioSaved: true,
            status: 'Recovered saved recording',
            complete: false,
        });
        expect(workspace.snapshot?.warning).toContain('buffered');
    });

    test('a recovery choice made while another operation is busy reports why it cannot run', async () => {
        const { workspace, store, writer } = fixture();
        let write!: () => void;
        writer.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    write = resolve;
                })
        );
        const recovery = workspace.recover(store);
        for (let i = 0; i < 12; i++) await Promise.resolve();
        await expect(workspace.chooseRecovery()).rejects.toThrow(
            'Finish the current session first'
        );
        await expect(workspace.recover(store)).rejects.toThrow('Finish the current session first');
        write();
        await recovery;
    });

    test('stopping while the panel opens prevents a late microphone session', async () => {
        const { workspace, settings, plugin, post } = fixture();
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
        Object.defineProperty(globalThis, 'MediaRecorder', {
            configurable: true,
            value: { isTypeSupported: () => true },
        });
        Object.assign(plugin.app.vault, { process: jest.fn() });
        settings.apiKey = 'key';
        settings.realtime = { ...DEFAULT_REALTIME_SETTINGS, enabled: true };
        let opened!: () => void;
        plugin.app.workspace.getLeavesOfType()[0].setViewState.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    opened = resolve;
                })
        );
        try {
            const starting = workspace.start();
            await workspace.stop();
            opened();
            await starting;
            expect(workspace.snapshot).toBeNull();
            expect(post).not.toHaveBeenCalled();
        } finally {
            if (descriptor) Object.defineProperty(globalThis, 'MediaRecorder', descriptor);
            else Reflect.deleteProperty(globalThis, 'MediaRecorder');
        }
    });

    test('registration and local recovery never start a provider request', async () => {
        const { workspace, post, store, writer } = fixture();
        expect(post).not.toHaveBeenCalled();
        await workspace.recover(store);
        expect(post).not.toHaveBeenCalled();
        expect(writer).toHaveBeenCalledTimes(1);
        expect(workspace.snapshot).toMatchObject({
            text: 'original live text',
            audioSaved: true,
            complete: false,
        });
    });

    test('uses current Deepgram credentials and preserves original text on speaker completion', async () => {
        const { workspace, store, settings, post } = fixture();
        await workspace.recover(store);
        settings.deepgramApiKey = 'updated-key';
        await workspace.processSpeakers();
        expect(post).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'updated-key', 'ko');
        expect(workspace.snapshot).toMatchObject({
            text: 'original live text',
            finalText: 'speaker text',
            postProcess: 'complete',
        });
        await workspace.processSpeakers();
        expect(post).toHaveBeenCalledTimes(1);
    });

    test.each([false, true])(
        'retries only local output after a speaker note failure (partial: %s)',
        async (partial) => {
            const { workspace, store, writer, post, settings } = fixture();
            await workspace.recover(store);
            if (partial)
                post.mockResolvedValue({ provider: 'deepgram', text: 'partial speaker text' });
            writer.mockRejectedValueOnce(new Error('note unavailable'));
            await expect(workspace.processSpeakers()).rejects.toThrow();
            settings.deepgramApiKey = '';
            await workspace.retrySave();
            expect(post).toHaveBeenCalledTimes(1);
            expect(writer).toHaveBeenCalledTimes(3);
            expect(workspace.snapshot).toMatchObject({
                finalText: partial ? 'partial speaker text' : 'speaker text',
                postProcess: partial ? 'partial' : 'complete',
                speakerOutputPending: false,
            });
            expect((await store.load())?.status).toContain('Speaker transcript saved');
        }
    );

    test('checkpoints a received speaker result before writing the note and confirms success afterwards', async () => {
        const { workspace, store, writer } = fixture();
        await workspace.recover(store);
        let finishWrite!: () => void;
        let markWriting!: () => void;
        const writing = new Promise<void>((resolve) => {
            markWriting = resolve;
        });
        writer.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishWrite = resolve;
                    markWriting();
                })
        );
        const processing = workspace.processSpeakers();
        await writing;
        const diskWhileWriting = await store.load();
        const panelWhileWriting = workspace.snapshot;
        finishWrite();
        await processing;
        expect(diskWhileWriting).toMatchObject({
            finalText: 'speaker text',
            speakerOutputPending: true,
            status: 'Saving speaker transcript',
        });
        expect(panelWhileWriting?.status).toBe('Saving speaker transcript');
        expect(await store.load()).toMatchObject({
            speakerOutputPending: false,
            status: 'Speaker transcript saved',
        });
    });

    test('retains a received result in memory when state writes fail and saves it without another upload', async () => {
        const { workspace, store, rawStore, writer, post, settings } = fixture();
        await workspace.recover(store);
        const save = rawStore.save.getMockImplementation()!;
        rawStore.save.mockImplementation(async (value) => {
            if (value.finalText) throw new Error('state unavailable');
            await save(value);
        });
        await expect(workspace.processSpeakers()).rejects.toThrow();
        expect(workspace.snapshot).toMatchObject({
            finalText: 'speaker text',
            status: 'Save needs attention',
            speakerOutputPending: true,
        });
        await expect(workspace.start()).rejects.toThrow('Retry saving');
        await expect(workspace.chooseRecovery()).rejects.toThrow('Retry saving');
        await expect(workspace.recover(store)).rejects.toThrow('Retry saving');
        rawStore.save.mockImplementation(save);
        settings.deepgramApiKey = '';
        await workspace.retrySave();
        expect(post).toHaveBeenCalledTimes(1);
        expect(writer).toHaveBeenCalledTimes(2);
        expect(workspace.snapshot?.status).toBe('Speaker transcript saved');
    });

    test('recovers a checkpointed speaker result after restart without another upload', async () => {
        const { workspace, store, writer, post, plugin, settings } = fixture();
        await workspace.recover(store);
        writer.mockRejectedValueOnce(new Error('note unavailable'));
        await expect(workspace.processSpeakers()).rejects.toThrow();
        workspace.dispose();
        settings.deepgramApiKey = '';
        const restarted = new RealtimeWorkspace(plugin as unknown as Plugin, () => settings);
        await restarted.recover(store);
        expect(restarted.snapshot).toMatchObject({
            finalText: 'speaker text',
            postProcess: 'complete',
            speakerOutputPending: false,
        });
        expect(post).toHaveBeenCalledTimes(1);
        expect(writer).toHaveBeenLastCalledWith(
            expect.objectContaining({ finalText: 'speaker text' })
        );
    });

    test('a state failure after writing the speaker note remains a save-only retry', async () => {
        const { workspace, store, rawStore, writer, post } = fixture();
        await workspace.recover(store);
        const save = rawStore.save.getMockImplementation()!;
        let failFinalState = true;
        rawStore.save.mockImplementation(async (value) => {
            if (failFinalState && value.status === 'Speaker transcript saved') {
                failFinalState = false;
                throw new Error('final state unavailable');
            }
            await save(value);
        });
        await expect(workspace.processSpeakers()).rejects.toThrow('Retry saving');
        expect(await store.load()).toMatchObject({ speakerOutputPending: true });
        await workspace.retrySave();
        expect(writer).toHaveBeenCalledTimes(3);
        expect(post).toHaveBeenCalledTimes(1);
        expect(workspace.snapshot?.status).toBe('Speaker transcript saved');
    });

    test('retrying a failed audio recovery reconstructs audio before saving a retained speaker result', async () => {
        const { workspace, store, rawStore, writer, post, plugin, settings } = fixture();
        await workspace.recover(store);
        writer.mockRejectedValueOnce(new Error('note unavailable'));
        await expect(workspace.processSpeakers()).rejects.toThrow();
        workspace.dispose();
        const restarted = new RealtimeWorkspace(plugin as unknown as Plugin, () => settings);
        rawStore.finalizeAudio.mockRejectedValueOnce(new Error('audio disk unavailable'));
        await expect(restarted.recover(store)).rejects.toThrow('audio disk unavailable');
        expect(restarted.snapshot).toMatchObject({ audioSaved: false, speakerOutputPending: true });
        const writesBeforeRetry = writer.mock.calls.length;
        await restarted.retrySave();
        expect(rawStore.finalizeAudio).toHaveBeenCalledTimes(3);
        expect(writer).toHaveBeenCalledTimes(writesBeforeRetry + 1);
        expect(restarted.snapshot).toMatchObject({ audioSaved: true, speakerOutputPending: false });
        expect(post).toHaveBeenCalledTimes(1);
    });

    test('does not call any provider when the Deepgram key is missing', async () => {
        const { workspace, store, settings, post } = fixture();
        await workspace.recover(store);
        settings.deepgramApiKey = '';
        await expect(workspace.processSpeakers()).rejects.toThrow('Deepgram');
        expect(post).not.toHaveBeenCalled();
    });

    test('reports missing speaker labels as partial even when a provider returns text', async () => {
        const { workspace, store, post } = fixture();
        await workspace.recover(store);
        post.mockResolvedValue({
            provider: 'deepgram',
            text: 'plain text',
            metadata: { diarizationEnabled: true },
        });
        await workspace.processSpeakers();
        expect(workspace.snapshot?.postProcess).toBe('partial');
    });

    test('unload during a disk read prevents a new upload', async () => {
        const { workspace, store, plugin, post } = fixture();
        await workspace.recover(store);
        let read!: (bytes: ArrayBuffer) => void;
        plugin.app.vault.adapter.readBinary.mockImplementation(
            () =>
                new Promise((resolve) => {
                    read = resolve;
                })
        );
        const processing = workspace.processSpeakers();
        for (let i = 0; i < 10; i++) await Promise.resolve();
        workspace.dispose();
        read(new ArrayBuffer(32));
        await processing;
        expect(post).not.toHaveBeenCalled();
    });

    test('unload while a provider is running prevents late text from being published or written', async () => {
        const { workspace, store, writer, post } = fixture();
        await workspace.recover(store);
        let complete!: (result: Awaited<ReturnType<RealtimePostProcessor['transcribe']>>) => void;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        post.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                    markStarted();
                })
        );
        const processing = workspace.processSpeakers();
        await started;
        workspace.dispose();
        complete({ provider: 'deepgram', text: 'late text' });
        await processing;
        expect(writer).toHaveBeenCalledTimes(1);
        expect(workspace.snapshot?.finalText).toBe('');
        expect((await store.load())?.finalText).toBe('');
        expect(workspace.snapshot?.postProcess).not.toBe('complete');
    });

    test('a failed provider leaves a retriable snapshot with the original recording', async () => {
        const { workspace, store, post } = fixture();
        await workspace.recover(store);
        post.mockRejectedValue(new Error('unavailable'));
        await expect(workspace.processSpeakers()).rejects.toThrow();
        expect(workspace.snapshot).toMatchObject({
            text: 'original live text',
            postProcess: 'failed',
            audioSaved: true,
        });
    });
});
