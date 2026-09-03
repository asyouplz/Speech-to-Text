import { requestUrl } from 'obsidian';

export class RealtimeAuthorizationError extends Error {}

/** 단기 토큰 발급 실패를 숨기거나 원본 API 키를 WebSocket에 보내지 않는다. */
export async function issueRealtimeProtocols(apiKey: string, session: unknown): Promise<string[]> {
    if (!apiKey.trim()) throw new Error('Set an OpenAI API key before starting live transcription');
    const response = await requestUrl({
        url: 'https://api.openai.com/v1/realtime/client_secrets',
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session }),
        throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
        throw new RealtimeAuthorizationError(
            `OpenAI session authorization failed (HTTP ${response.status})`
        );
    }
    const data: unknown = response.json;
    const value = data && typeof data === 'object' ? (data as Record<string, unknown>).value : null;
    if (typeof value !== 'string' || !value) throw new Error('OpenAI returned no session token');
    return ['realtime', `openai-insecure-api-key.${value}`];
}
