/**
 * Decodes the `ns` (namespace) claim from a HAPI access token's JWT payload,
 * client-side only — used to gate owner-only UI (Settings categories, the
 * Boards mode switch) before the request round-trips to the hub, which
 * enforces the real check server-side regardless.
 */
export function getNamespaceFromToken(token: string | null): string | null {
    if (!token) return null
    try {
        const payload = token.split('.')[1]
        if (!payload) return null
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
        const decoded = JSON.parse(atob(base64)) as { ns?: unknown }
        return typeof decoded.ns === 'string' ? decoded.ns : null
    } catch {
        return null
    }
}

export function isOwnerNamespace(token: string | null): boolean {
    return getNamespaceFromToken(token) === 'default'
}
