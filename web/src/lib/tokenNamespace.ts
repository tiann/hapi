/**
 * Decode the `ns` claim from a HAPI access JWT (middle segment).
 * Returns null when the token is missing/malformed or has no string `ns`.
 */
export function getTokenNamespace(token: string | null | undefined): string | null {
    if (!token) {
        return null
    }
    try {
        const payload = token.split('.')[1]
        if (!payload) {
            return null
        }
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
        const decoded = JSON.parse(atob(base64)) as { ns?: unknown }
        return typeof decoded.ns === 'string' ? decoded.ns : null
    } catch {
        return null
    }
}

/** Hub-global settings (fleet upgrade policy, hub storage) are default-namespace only. */
export function isDefaultNamespaceToken(token: string | null | undefined): boolean {
    return getTokenNamespace(token) === 'default'
}
