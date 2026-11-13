export const SESSION_MENTION_DRAG_MIME = 'application/x-hapi-session-mention'

export function parseSessionMentionDrag(dataTransfer: Pick<DataTransfer, 'getData'>): { id: string; title: string } | null {
    try {
        const { id, title } = JSON.parse(dataTransfer.getData(SESSION_MENTION_DRAG_MIME)) ?? {}
        return typeof id === 'string' && id.trim() && typeof title === 'string' ? { id, title } : null
    } catch {
        return null
    }
}
