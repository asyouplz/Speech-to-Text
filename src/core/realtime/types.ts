/** 실시간 경로는 파일 전사 Provider와 독립적으로 유지한다. */
export interface RealtimeSettings {
    enabled: boolean;
    language: string;
    prompt: string;
    maxMinutes: number;
    postProcess: boolean;
}

export const DEFAULT_REALTIME_SETTINGS: RealtimeSettings = {
    enabled: false,
    language: 'ko',
    prompt: '',
    maxMinutes: 45,
    postProcess: false,
};

export function normalizeRealtimeSettings(value: unknown): RealtimeSettings {
    const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return {
        enabled: source.enabled === true,
        language:
            typeof source.language === 'string' && /^[a-z]{2,3}(-[a-z]{2})?$/.test(source.language)
                ? source.language
                : 'ko',
        prompt: typeof source.prompt === 'string' ? source.prompt.slice(0, 1000) : '',
        maxMinutes:
            typeof source.maxMinutes === 'number' && Number.isFinite(source.maxMinutes)
                ? Math.max(1, Math.min(55, Math.floor(source.maxMinutes)))
                : 45,
        postProcess: source.postProcess === true,
    };
}

export interface SessionMetadata {
    id: string;
    startedAt: string;
    mimeType: string;
    notePath: string;
}

export interface SessionSnapshot {
    revision: number;
    text: string;
    complete: boolean;
    status: string;
    warning: string;
    finalText: string;
    audioSaved: boolean;
    postProcess: 'none' | 'running' | 'complete' | 'partial' | 'failed';
}

export interface RealtimeResult {
    text: string;
    complete: boolean;
}

export interface RealtimeTranscriber {
    connect(): Promise<void>;
    append(samples: Float32Array): void;
    finish(): Promise<RealtimeResult>;
    close(): void;
}
