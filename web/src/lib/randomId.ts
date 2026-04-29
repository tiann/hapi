/**
 * Generates a random ID string that works in both secure and non-secure contexts.
 *
 * crypto.randomUUID() is only available in secure contexts (HTTPS or localhost).
 * When accessed over HTTP on a LAN IP, it throws TypeError, breaking file
 * attachment and other ID-generation paths.
 *
 * Fallback chain:
 *   1. crypto.randomUUID()           — secure context (HTTPS / localhost)
 *   2. crypto.getRandomValues()      — available in non-secure contexts on modern browsers
 *   3. Date.now() + Math.random()    — last resort for very old environments
 *
 * All paths return a UUID v4-format string or a similarly unique string,
 * maintaining compatibility with existing ID consumers (DB, SSE, RPC payloads).
 */
export function randomId(): string {
    const c = globalThis.crypto

    if (typeof c?.randomUUID === 'function') {
        return c.randomUUID()
    }

    if (typeof c?.getRandomValues === 'function') {
        const bytes = new Uint8Array(16)
        c.getRandomValues(bytes)
        // Set version 4 bits
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        // Set variant bits
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }

    // Fallback for environments without any crypto support
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}
