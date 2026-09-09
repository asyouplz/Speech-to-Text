/** EBML prefix used by WebM. This identifies a header, not a fully validated container. */
export const WEBM_SIGNATURE = Object.freeze([0x1a, 0x45, 0xdf, 0xa3] as const);

export function isWebmSignature(bytes: Uint8Array): boolean {
    return (
        bytes.length >= WEBM_SIGNATURE.length &&
        WEBM_SIGNATURE.every((value, index) => bytes[index] === value)
    );
}
