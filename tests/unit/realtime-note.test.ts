import { SessionNoteWriter } from '../../src/core/realtime/SessionNoteWriter';
import type { RealtimeSessionStore } from '../../src/infrastructure/storage/RealtimeSessionStore';
import { TFile, Vault } from 'obsidian';
import type { LiveSnapshot } from '../../src/core/realtime/LiveSessionController';
import { webcrypto } from 'crypto';

test('note revisions retain user edits, preserve the original transcript, and avoid duplicate speaker results', async () => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    let text = '';
    let file: TFile | null = null;
    const vault = {
        getAbstractFileByPath: jest.fn(() => file),
        create: jest.fn(async (_: string, content: string) => {
            text = content;
            file = new TFile();
        }),
        process: jest.fn(async (_: TFile, transform: (current: string) => string) => {
            text = transform(text);
        }),
    };
    const store = {
        metadata: { id: 'meeting', startedAt: 'today', notePath: 'meeting.md' },
        audioPath: 'meeting.webm',
    };
    const writer = new SessionNoteWriter(vault as unknown as Vault, store as RealtimeSessionStore);
    const snapshot: LiveSnapshot = {
        text: 'line one\nline two',
        complete: false,
        warning: '',
        status: 'saved',
        audioSaved: true,
        finalText: '',
        postProcess: 'none',
    };
    await writer.write(snapshot);
    text += '\nUser notes added afterwards';
    const final = { ...snapshot, finalText: 'Speaker 1: hello', postProcess: 'complete' as const };
    await writer.write(final);
    await writer.write({ ...final, speakerOutputPending: true, status: 'Save needs attention' });
    await writer.write({
        ...final,
        speakerOutputPending: false,
        status: 'Speaker transcript saved',
    });
    expect(text).toContain('line one\nline two');
    expect(text).toContain('User notes added afterwards');
    expect(text.match(/Speaker 1: hello/g)).toHaveLength(1);
    expect(text.match(/Live transcript \(original\)/g)).toHaveLength(1);
});
