export function buildSessionReferencePath(sessionId: string): string {
    const base = import.meta.env.BASE_URL ?? '/'
    const normalizedBase = base.endsWith('/') ? base : `${base}/`
    return `${normalizedBase}sessions/${encodeURIComponent(sessionId)}`.replace(/\/{2,}/g, '/')
}

function sanitizeSessionReferenceTitle(sessionTitle: string): string {
    return sessionTitle.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** Clipboard text for citing this session in another HAPI chat (not a public share link). */
export function buildSessionReferenceText(sessionTitle: string, sessionId: string): string {
    const path = buildSessionReferencePath(sessionId)
    const title = sanitizeSessionReferenceTitle(sessionTitle)
    if (title) {
        return `See session ${JSON.stringify(title)} (${path}) for context`
    }
    return `See HAPI session ${path} for context`
}
