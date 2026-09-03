/** btoa 인자 길이 한계를 피하기 위한 청크 크기 */
const BASE64_CHUNK = 0x8000;

/**
 * Float32(-1.0 ~ 1.0) 를 리틀엔디언 PCM16 으로 변환한다.
 */
export function floatToPcm16(input: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < input.length; i++) {
        const clamped = Math.max(-1, Math.min(1, input[i]));
        // 음수와 양수의 스케일이 다르다. -32768 ~ 32767
        view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    }

    return buffer;
}

/**
 * ArrayBuffer 를 base64 문자열로 변환한다.
 * String.fromCharCode 는 인자 개수 한계가 있으므로 청크로 나눈다.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';

    for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
        const slice = Array.from(bytes.subarray(i, i + BASE64_CHUNK));
        binary += String.fromCharCode(...slice);
    }

    return btoa(binary);
}

export function floatToBase64Pcm16(input: Float32Array): string {
    return arrayBufferToBase64(floatToPcm16(input));
}
