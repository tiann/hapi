export function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split('.')
    if (parts.length < 2) return null

    const payloadBase64Url = parts[1] ?? ''
    const payloadBase64 = payloadBase64Url
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(payloadBase64Url.length / 4) * 4, '=')

    try {
        const decoded = globalThis.atob(payloadBase64)
        const parsed: unknown = JSON.parse(decoded)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null
        }
        return parsed as Record<string, unknown>
    } catch {
        return null
    }
}

export function decodeJwtExpMs(token: string): number | null {
    const payload = decodeJwtPayload(token)
    if (payload === null) return null
    if (typeof payload.exp !== 'number') return null
    return payload.exp * 1000
}

export function isCloudflareToken(token: string): boolean {
    return decodeJwtPayload(token)?.authMethod === 'cloudflareAccess'
}

export function decodeJwtIdentityKey(token: string): string | null {
    const payload = decodeJwtPayload(token)
    if (!payload) return null
    const authMethod = typeof payload.authMethod === 'string' ? payload.authMethod : ''
    const ns = typeof payload.ns === 'string' ? payload.ns : ''
    const sub = typeof payload.cfAccessSub === 'string' ? payload.cfAccessSub : ''
    const email = typeof payload.cfAccessEmail === 'string' ? payload.cfAccessEmail.trim().toLowerCase() : ''
    const uid = typeof payload.uid === 'number' || typeof payload.uid === 'string' ? String(payload.uid) : ''
    if (!authMethod && !ns && !sub && !email && !uid) {
        return null
    }
    return JSON.stringify([authMethod, ns, sub, email, uid])
}
