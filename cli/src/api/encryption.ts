export function encodeBase64(buffer: Uint8Array): string {
    return Buffer.from(buffer).toString('base64')
}
