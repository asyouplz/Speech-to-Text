import type { DataAdapter } from 'obsidian';
import { isWebmSignature } from '../../utils/audioSignature';
import type { SessionMetadata, SessionSnapshot } from '../../core/realtime/types';

export const SESSION_ROOT = 'Recordings/SpeechNote';
const MAX_RECORDING_BYTES = 64 * 1024 * 1024;

type Storage = Pick<
    DataAdapter,
    'exists' | 'mkdir' | 'write' | 'read' | 'writeBinary' | 'readBinary' | 'rename' | 'list'
>;

/** 조각을 먼저 보존한다. 완료 파일을 만드는 데 실패해도 원본 조각은 삭제하지 않는다. */
export class RealtimeSessionStore {
    private revision = 0;
    private writes: Promise<void> = Promise.resolve();

    constructor(private adapter: Storage, readonly metadata: SessionMetadata) {
        if (!/^[a-zA-Z0-9-]+$/.test(metadata.id)) throw new Error('Invalid session identifier');
    }

    get folder(): string {
        return `${SESSION_ROOT}/${this.metadata.id}`;
    }

    get audioPath(): string {
        return `${this.folder}/recording.webm`;
    }

    async create(): Promise<void> {
        let path = '';
        for (const part of this.folder.split('/')) {
            path = path ? `${path}/${part}` : part;
            if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
        }
        await this.adapter.write(`${this.folder}/session.json`, JSON.stringify(this.metadata));
    }

    async writeChunk(index: number, bytes: ArrayBuffer): Promise<void> {
        if (!Number.isInteger(index) || index < 0 || bytes.byteLength === 0) {
            throw new Error('Invalid recording chunk');
        }
        const path = `${this.folder}/audio-${index.toString().padStart(6, '0')}.part`;
        // A rejected rename can still have completed on disk. Verify before retrying.
        if (await this.adapter.exists(path)) {
            const previous = new Uint8Array(await this.adapter.readBinary(path));
            const next = new Uint8Array(bytes);
            if (previous.length === next.length && previous.every((byte, i) => byte === next[i])) {
                return;
            }
            throw new Error('Recording chunk already exists with different contents');
        }
        await this.adapter.writeBinary(`${path}.pending`, bytes);
        await this.adapter.rename(`${path}.pending`, path);
    }

    save(snapshot: Omit<SessionSnapshot, 'revision'>): Promise<void> {
        const copy = { ...snapshot };
        const write = this.writes.then(async () => {
            const revision = this.revision + 1;
            await this.adapter.write(
                `${this.folder}/state-${revision % 2}.json`,
                JSON.stringify({ ...copy, revision })
            );
            this.revision = revision;
        });
        // Keep a valid previous checkpoint if a write is interrupted, and permit a later retry.
        this.writes = write.catch(() => undefined);
        return write;
    }

    async load(): Promise<SessionSnapshot | null> {
        const states: SessionSnapshot[] = [];
        for (const slot of [0, 1]) {
            try {
                const parsed: unknown = JSON.parse(
                    await this.adapter.read(`${this.folder}/state-${slot}.json`)
                );
                if (isSnapshot(parsed)) states.push(parsed);
            } catch {
                // One interrupted checkpoint must not hide the other valid checkpoint.
            }
        }
        const latest = states.sort((a, b) => b.revision - a.revision)[0] ?? null;
        this.revision = latest?.revision ?? 0;
        return latest;
    }

    async finalizeAudio(): Promise<string> {
        const { files } = await this.adapter.list(this.folder);
        const parts = files.filter((path) => /\/audio-\d{6}\.part$/.test(path)).sort();
        if (parts.length === 0) throw new Error('No saved recording chunks were found');
        const buffers: ArrayBuffer[] = [];
        let size = 0;
        for (const [index, path] of parts.entries()) {
            if (!path.endsWith(`/audio-${index.toString().padStart(6, '0')}.part`)) {
                throw new Error('A recording chunk is missing; the saved parts have been retained');
            }
            const bytes = await this.adapter.readBinary(path);
            size += bytes.byteLength;
            if (!bytes.byteLength || size > MAX_RECORDING_BYTES) {
                throw new Error('Recording is empty or exceeds the 64 MB recovery limit');
            }
            buffers.push(bytes);
        }
        const result = new Uint8Array(size);
        let offset = 0;
        for (const bytes of buffers) {
            result.set(new Uint8Array(bytes), offset);
            offset += bytes.byteLength;
        }
        if (!isWebmSignature(result)) {
            throw new Error('The saved recording does not contain a WebM header');
        }
        // Regeneration also includes a late final chunk from an interrupted stop operation.
        await this.adapter.writeBinary(this.audioPath, result.buffer);
        return this.audioPath;
    }

    static async list(adapter: Storage): Promise<RealtimeSessionStore[]> {
        if (!(await adapter.exists(SESSION_ROOT))) return [];
        const result: RealtimeSessionStore[] = [];
        const { folders } = await adapter.list(SESSION_ROOT);
        for (const folder of folders) {
            try {
                const value: unknown = JSON.parse(await adapter.read(`${folder}/session.json`));
                if (isMetadata(value) && folder === `${SESSION_ROOT}/${value.id}`) {
                    result.push(new RealtimeSessionStore(adapter, value));
                }
            } catch {
                // Leave an unreadable session untouched; other sessions remain recoverable.
            }
        }
        return result.sort((a, b) => b.metadata.startedAt.localeCompare(a.metadata.startedAt));
    }
}

function isMetadata(value: unknown): value is SessionMetadata {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.id === 'string' &&
        /^[a-zA-Z0-9-]+$/.test(v.id) &&
        typeof v.startedAt === 'string' &&
        typeof v.mimeType === 'string' &&
        typeof v.notePath === 'string' &&
        v.notePath === `${SESSION_ROOT}/${v.id}/transcript.md`
    );
}

function isSnapshot(value: unknown): value is SessionSnapshot {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.revision === 'number' &&
        Number.isInteger(v.revision) &&
        v.revision > 0 &&
        typeof v.text === 'string' &&
        typeof v.complete === 'boolean' &&
        typeof v.status === 'string' &&
        typeof v.warning === 'string' &&
        typeof v.finalText === 'string' &&
        typeof v.audioSaved === 'boolean' &&
        ['none', 'running', 'complete', 'partial', 'failed'].includes(String(v.postProcess))
    );
}
