export function buildSessionReferencePath(sessionId: string): string {
    const base = import.meta.env.BASE_URL ?? '/'
    const normalizedBase = base.endsWith('/') ? base : `${base}/`
    return `${normalizedBase}sessions/${encodeURIComponent(sessionId)}`.replace(/\/{2,}/g, '/')
}

/** Clipboard text for citing this session in another HAPI chat (not a public share link). */
export function buildSessionReferenceText(sessionTitle: string, sessionId: string): string {
    const path = buildSessionReferencePath(sessionId)
    return `See session "${sessionTitle}" (${path}) for context`
}
