import type { Vault } from 'obsidian';
import type { RealtimeSessionStore } from '../../infrastructure/storage/RealtimeSessionStore';
import type { LiveSnapshot } from './LiveSessionController';
import { assertTFile } from '../../utils/fs/typeGuards';

/** Live UI never edits the user's editor. Each completed revision is appended once to its note. */
export class SessionNoteWriter {
    constructor(private vault: Vault, private store: RealtimeSessionStore) {}

    async write(snapshot: LiveSnapshot): Promise<void> {
        const path = this.store.metadata.notePath;
        const original = [
            '## Live transcript (original)',
            '',
            `Status: ${snapshot.complete ? 'Complete' : 'Incomplete'}`,
            snapshot.warning ? `\n${snapshot.warning}` : '',
            snapshot.audioSaved ? `\n![[${this.store.audioPath}]]` : '',
            '',
            snapshot.text || '(No transcript was received)',
            '',
        ].join('\n');
        const contents = [original];
        if (snapshot.finalText)
            contents.push(
                `## Speaker transcript\n\nStatus: ${snapshot.postProcess}\n\n${snapshot.finalText}\n`
            );
        const blocks = await Promise.all(
            contents.map(async (body) => {
                const digest = await crypto.subtle.digest(
                    'SHA-256',
                    new TextEncoder().encode(body)
                );
                const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
                    byte.toString(16).padStart(2, '0')
                ).join('');
                const marker = `<!-- speechnote:${this.store.metadata.id}:${fingerprint} -->`;
                return { marker, text: `${marker}\n${body}` };
            })
        );
        const append = (current: string) =>
            blocks.reduce(
                (text, block) => (text.includes(block.marker) ? text : `${text}\n\n${block.text}`),
                current
            );
        const file = this.vault.getAbstractFileByPath(path);
        if (!file) {
            await this.vault.create(path, append(`# Meeting ${this.store.metadata.startedAt}`));
        } else {
            assertTFile(file);
            await this.vault.process(file, append);
        }
    }
}
