type SessionTitleSource = {
    id: string
    metadata?: {
        name?: string
        summary?: { text: string }
        path?: string
    } | null
}

export function getSessionTitle(session: SessionTitleSource): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}
