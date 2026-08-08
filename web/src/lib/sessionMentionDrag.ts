export const SESSION_MENTION_DRAG_MIME = 'application/x-hapi-session-mention'

export type SessionMentionDrag = {
    id: string
    title: string
}

export function parseSessionMentionDrag(dataTransfer: Pick<DataTransfer, 'getData'>): SessionMentionDrag | null {
    try {
        const payload: unknown = JSON.parse(dataTransfer.getData(SESSION_MENTION_DRAG_MIME))
        if (
            !payload
            || typeof payload !== 'object'
            || typeof (payload as SessionMentionDrag).id !== 'string'
            || typeof (payload as SessionMentionDrag).title !== 'string'
        ) return null
        const { id, title } = payload as SessionMentionDrag
        return id.trim() ? { id, title } : null
    } catch {
        return null
    }
}
