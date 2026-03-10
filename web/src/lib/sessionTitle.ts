import type { Session, SessionSummary } from '@/types/api'

type SessionLike = Pick<Session, 'id' | 'metadata'> | Pick<SessionSummary, 'id' | 'metadata'>

export function getSessionTitle(
    session: SessionLike,
    opts: { allowGeneratedTitle?: boolean } = {}
): string {
    const allowGeneratedTitle = opts.allowGeneratedTitle ?? true

    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (allowGeneratedTitle && session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}
