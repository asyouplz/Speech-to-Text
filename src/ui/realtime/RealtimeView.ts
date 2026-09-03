import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { RealtimeWorkspace } from '../../application/RealtimeWorkspace';

export const REALTIME_VIEW_TYPE = 'speechnote-live-transcription';

export class RealtimeView extends ItemView {
    private unsubscribe: (() => void) | null = null;
    constructor(leaf: WorkspaceLeaf, private controller: RealtimeWorkspace) {
        super(leaf);
    }
    getViewType(): string {
        return REALTIME_VIEW_TYPE;
    }
    getDisplayText(): string {
        return 'Live transcription';
    }
    getIcon(): string {
        return 'mic';
    }

    onOpen(): Promise<void> {
        this.unsubscribe?.();
        const container = this.contentEl;
        container.empty();
        container.createEl('h2', { text: 'Live transcription' });
        container.createEl('p', {
            text: 'Microphone audio is sent to OpenAI while recording. Audio and transcripts are saved in your vault.',
        });
        const controls = container.createDiv();
        const actions: [string, () => Promise<void>][] = [
            ['Start', () => this.controller.start()],
            ['Stop and save', () => this.controller.stop()],
            ['Retry saving', () => this.controller.retrySave()],
            ['Recover recording', () => this.controller.chooseRecovery()],
            ['Transcribe speakers (Deepgram)', () => this.controller.processSpeakers()],
            ['Open meeting note', () => this.controller.openNote()],
        ];
        for (const [text, action] of actions) {
            const button = controls.createEl('button', { text });
            this.registerDomEvent(button, 'click', () => this.controller.perform(action));
        }
        const status = container.createEl('p');
        status.setAttribute('role', 'status');
        const warning = container.createEl('p', { cls: 'mod-warning' });
        const transcript = container.createEl('pre', { cls: 'speechnote-live-transcript' });
        this.unsubscribe = this.controller.subscribe(() => {
            const snapshot = this.controller.snapshot;
            status.setText(snapshot?.status ?? 'Ready');
            warning.setText(snapshot?.warning ?? '');
            transcript.setText(snapshot?.finalText || snapshot?.text || 'Waiting for speech…');
        });
        return Promise.resolve();
    }
    onClose(): Promise<void> {
        this.unsubscribe?.();
        return Promise.resolve();
    }
}
