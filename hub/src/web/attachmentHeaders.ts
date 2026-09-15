/**
 * Build a safe Content-Disposition value for a user-controlled filename.
 *
 * Headers only accept ByteString values. Keep an ASCII fallback for older
 * clients and include RFC 5987's UTF-8 filename for clients that support it.
 */
export function attachmentContentDisposition(filename: string): string {
    const safe = filename.replace(/[\r\n\0"\\]/g, '_')
    const ascii = safe.replace(/[^\x20-\x7e]/g, '_')
    if (ascii === safe) {
        return `attachment; filename="${ascii}"`
    }

    const encoded = encodeURIComponent(safe).replace(/['()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    )
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
