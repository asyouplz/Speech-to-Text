import { Notice, Platform, SuggestModal } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import type { SpeechToTextSettings } from '../domain/models/Settings';
import { normalizeRealtimeSettings } from '../core/realtime/types';
import { LiveSessionController, LiveSnapshot } from '../core/realtime/LiveSessionController';
import { SessionNoteWriter } from '../core/realtime/SessionNoteWriter';
import { RealtimePostProcessor } from '../core/realtime/RealtimePostProcessor';
import { RealtimeSessionStore, SESSION_ROOT } from '../infrastructure/storage/RealtimeSessionStore';
import { MicrophoneCapture } from '../infrastructure/audio/MicrophoneCapture';
import { LocalRecorder } from '../infrastructure/audio/LocalRecorder';
import { OpenAIRealtimeTranscriber } from '../infrastructure/api/providers/realtime/OpenAIRealtimeTranscriber';
import { RealtimeView, REALTIME_VIEW_TYPE } from '../ui/realtime/RealtimeView';

/** No microphone, network, or recovery upload occurs on plugin load. */
export class RealtimeWorkspace {
    snapshot: LiveSnapshot | null = null;
    private run: LiveSessionController | null = null;
    private selected: RealtimeSessionStore | null = null;
    private listeners = new Set<() => void>();
    private stopping: Promise<void> | null = null;
    private busy = false;
    private startGeneration = 0;
    private disposed = false;
    private autoPostProcess = false;
    private language = 'ko';
    private processor: RealtimePostProcessor | null = null;

    constructor(private plugin: Plugin, private getSettings: () => SpeechToTextSettings) {
        if (Platform.isMobile) return;
        plugin.registerView(REALTIME_VIEW_TYPE, (leaf) => new RealtimeView(leaf, this));
        plugin.addCommand({
            id: 'start-live-transcription',
            name: 'Start live microphone transcription',
            callback: () => this.perform(() => this.start()),
        });
        plugin.addCommand({
            id: 'stop-live-transcription',
            name: 'Stop live microphone transcription',
            callback: () => this.perform(() => this.stop()),
        });
        plugin.addCommand({
            id: 'recover-live-transcription',
            name: 'Recover saved live recording',
            callback: () => this.perform(() => this.chooseRecovery()),
        });
        plugin.addCommand({
            id: 'show-live-transcription',
            name: 'Show live transcription panel',
            callback: () => this.perform(() => this.open()),
        });
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        listener();
        return () => this.listeners.delete(listener);
    }

    private publish(snapshot: LiveSnapshot): void {
        this.snapshot = { ...snapshot };
        this.listeners.forEach((listener) => listener());
    }

    perform(action: () => Promise<void>): void {
        void action().catch((error: unknown) => {
            new Notice(
                error instanceof Error ? error.message : 'Live transcription could not complete'
            );
        });
    }

    async open(): Promise<void> {
        const workspace = this.plugin.app.workspace;
        const leaf =
            workspace.getLeavesOfType(REALTIME_VIEW_TYPE)[0] ?? workspace.getRightLeaf(false);
        if (!leaf) throw new Error('Could not open the live transcription panel');
        await leaf.setViewState({ type: REALTIME_VIEW_TYPE, active: true });
        await workspace.revealLeaf(leaf);
    }

    async start(): Promise<void> {
        if (this.disposed || Platform.isMobile) return;
        if (this.busy || this.run?.isActive || this.stopping)
            throw new Error('Finish the current session first');
        if (this.run?.hasRecording && this.run.snapshot.status === 'Save needs attention') {
            throw new Error('Use Retry saving before starting another recording');
        }
        const settings = this.getSettings();
        const options = normalizeRealtimeSettings(settings.realtime);
        if (!options.enabled)
            throw new Error('Enable live transcription in SpeechNote settings first');
        if (typeof this.plugin.app.vault.process !== 'function')
            throw new Error(
                'Update Obsidian before using live transcription; safe note updates are unavailable in this version'
            );
        const apiKey = settings.whisperApiKey || settings.apiKey;
        if (!apiKey) throw new Error('Set an OpenAI API key in SpeechNote settings first');
        if (options.postProcess && !settings.deepgramApiKey)
            throw new Error('Set a Deepgram API key or turn off automatic speaker transcription');
        if (
            typeof MediaRecorder === 'undefined' ||
            !MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ) {
            throw new Error('This environment does not support WebM microphone recording');
        }
        this.busy = true;
        const generation = ++this.startGeneration;
        try {
            await this.open();
            if (this.disposed || generation !== this.startGeneration) return;
            const id = `${Date.now()}-${crypto.randomUUID()}`;
            const store = new RealtimeSessionStore(this.plugin.app.vault.adapter, {
                id,
                startedAt: new Date().toISOString(),
                mimeType: 'audio/webm;codecs=opus',
                notePath: `${SESSION_ROOT}/${id}/transcript.md`,
            });
            const writer = new SessionNoteWriter(this.plugin.app.vault, store);
            const microphone = new MicrophoneCapture();
            const recorder: LocalRecorder = new LocalRecorder(
                (index, bytes) => store.writeChunk(index, bytes),
                () => run.recordingFailed()
            );
            const realtime: OpenAIRealtimeTranscriber = new OpenAIRealtimeTranscriber(
                apiKey,
                options,
                (text) => run.receiveText(text),
                () => run.disconnected()
            );
            const run: LiveSessionController = new LiveSessionController(
                store,
                microphone,
                recorder,
                realtime,
                options.maxMinutes,
                (snapshot) => this.publish(snapshot),
                (snapshot) => writer.write(snapshot),
                () => this.perform(() => this.stop())
            );
            this.run = run;
            this.selected = store;
            this.autoPostProcess = options.postProcess;
            this.language = options.language;
            this.publish(run.snapshot);
            await run.start();
        } finally {
            this.busy = false;
        }
    }

    stop(): Promise<void> {
        this.startGeneration++;
        if (this.stopping) return this.stopping;
        const run = this.run;
        if (!run || !run.isActive) return Promise.resolve();
        this.stopping = run
            .stop()
            .then(async () => {
                if (
                    !this.disposed &&
                    this.autoPostProcess &&
                    run.snapshot.status === 'Recording saved'
                )
                    await this.transcribeSavedSession();
            })
            .finally(() => {
                this.stopping = null;
            });
        return this.stopping;
    }

    async retrySave(): Promise<void> {
        if (this.busy || this.stopping) throw new Error('Wait for the current operation to finish');
        if (!this.run) {
            if (!this.selected) throw new Error('Select a saved recording with Recover recording');
            if (this.snapshot?.status === 'Save needs attention') await this.recover(this.selected);
            return;
        }
        this.busy = true;
        try {
            await this.run.retrySave();
        } finally {
            this.busy = false;
        }
    }

    async chooseRecovery(): Promise<void> {
        this.ensureRecoveryAvailable();
        const sessions = await RealtimeSessionStore.list(this.plugin.app.vault.adapter);
        if (!sessions.length) throw new Error('No saved recording sessions were found');
        new RecoveryModal(this.plugin.app, sessions, (store) =>
            this.perform(() => this.recover(store))
        ).open();
    }

    async recover(store: RealtimeSessionStore): Promise<void> {
        this.ensureRecoveryAvailable();
        this.busy = true;
        let snapshot: LiveSnapshot | null = null;
        try {
            const saved = await store.load();
            snapshot = saved
                ? { ...saved }
                : {
                      text: '',
                      complete: false,
                      status: '',
                      warning: '',
                      finalText: '',
                      audioSaved: false,
                      postProcess: 'none',
                  };
            this.run = null;
            this.selected = store;
            snapshot.status = 'Recovering saved recording';
            this.publish(snapshot);
            await this.open();
            await store.finalizeAudio();
            snapshot.audioSaved = true;
            if (!saved?.audioSaved) {
                snapshot.complete = false;
                snapshot.warning =
                    'Recovered persisted chunks. Audio still buffered when the app closed may be missing.';
            }
            if (snapshot.postProcess === 'running') snapshot.postProcess = 'failed';
            const recovered = { ...snapshot, status: 'Recovered saved recording' };
            await new SessionNoteWriter(this.plugin.app.vault, store).write(recovered);
            await store.save(recovered);
            Object.assign(snapshot, recovered);
            this.publish(snapshot);
        } catch (error) {
            if (snapshot) {
                snapshot.status = 'Save needs attention';
                snapshot.warning =
                    'Recovery output could not be saved. Use Retry saving to finish this recovery.';
                await store.save(snapshot).catch(() => undefined);
                this.publish(snapshot);
            }
            throw error;
        } finally {
            this.busy = false;
        }
    }

    private ensureRecoveryAvailable(): void {
        if (this.disposed) throw new Error('Live transcription is no longer available');
        if (this.busy || this.run?.isActive || this.stopping)
            throw new Error('Finish the current session first');
        if (this.run?.hasRecording && this.run.snapshot.status === 'Save needs attention')
            throw new Error('Use Retry saving to preserve the current session first');
    }

    async processSpeakers(): Promise<void> {
        if (this.stopping) throw new Error('Wait for the recording to finish saving');
        await this.transcribeSavedSession();
    }

    private async transcribeSavedSession(): Promise<void> {
        const store = this.selected;
        if (this.disposed || this.busy || this.run?.isActive || !store)
            throw new Error('Stop or recover a recording first');
        const apiKey = this.getSettings().deepgramApiKey;
        if (this.snapshot?.status === 'Save needs attention')
            throw new Error('Use Retry saving before speaker transcription');
        if (!apiKey) throw new Error('Set a Deepgram API key before speaker transcription');
        this.busy = true;
        const processor = new RealtimePostProcessor();
        this.processor = processor;
        let snapshot: LiveSnapshot | null = null;
        try {
            snapshot = await store.load();
            if (!snapshot?.audioSaved) throw new Error('Recover or save the recording first');
            if (snapshot.postProcess === 'complete') return;
            snapshot.postProcess = 'running';
            snapshot.status = 'Transcribing saved audio with Deepgram';
            await store.save(snapshot);
            this.publish(snapshot);
            const audio = await this.plugin.app.vault.adapter.readBinary(store.audioPath);
            if (this.disposed) return;
            const result = await processor.transcribe(
                audio,
                apiKey,
                this.run
                    ? this.language
                    : normalizeRealtimeSettings(this.getSettings().realtime).language
            );
            if (this.disposed) return;
            if (result.provider !== 'deepgram' || !result.text.trim())
                throw new Error('Deepgram returned no usable transcript');
            snapshot.finalText = result.text;
            const hasSpeakers =
                !!result.segments?.length &&
                result.segments.every(
                    (segment) => typeof segment.speaker === 'string' && !!segment.speaker
                );
            snapshot.postProcess =
                result.metadata?.isPartial || !hasSpeakers ? 'partial' : 'complete';
            snapshot.status =
                snapshot.postProcess === 'complete'
                    ? 'Speaker transcript saved'
                    : 'Speaker transcript saved with incomplete speaker information';
            await store.save(snapshot);
            await new SessionNoteWriter(this.plugin.app.vault, store).write(snapshot);
            this.publish(snapshot);
        } catch (error) {
            if (snapshot) {
                snapshot.postProcess = 'failed';
                snapshot.status =
                    'Speaker transcription needs attention; original recording retained';
                await store.save(snapshot);
                this.publish(snapshot);
            }
            throw error;
        } finally {
            this.processor = null;
            this.busy = false;
        }
    }

    async openNote(): Promise<void> {
        if (this.selected)
            await this.plugin.app.workspace.openLinkText(this.selected.metadata.notePath, '', true);
    }

    dispose(): void {
        this.disposed = true;
        this.processor?.cancel();
        if (this.run) void this.run.interrupt().catch(() => undefined);
        this.listeners.clear();
    }
}

class RecoveryModal extends SuggestModal<RealtimeSessionStore> {
    constructor(
        app: App,
        private stores: RealtimeSessionStore[],
        private choose: (store: RealtimeSessionStore) => void
    ) {
        super(app);
        this.setPlaceholder('Choose a recording to recover locally');
    }
    getSuggestions(query: string): RealtimeSessionStore[] {
        return this.stores.filter((store) =>
            `${store.metadata.startedAt} ${store.metadata.id}`.includes(query)
        );
    }
    renderSuggestion(store: RealtimeSessionStore, el: HTMLElement): void {
        el.setText(store.metadata.startedAt);
    }
    onChooseSuggestion(store: RealtimeSessionStore): void {
        this.choose(store);
    }
}
