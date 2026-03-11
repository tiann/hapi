import type { Session, SessionSummary } from '@/types/api'

type SessionWithModelMetadata =
    | Pick<Session, 'metadata' | 'modelMode'>
    | Pick<SessionSummary, 'metadata' | 'modelMode'>

export function getSessionModelLabel(session: SessionWithModelMetadata): string {
    const actualModel = session.metadata?.model?.trim()
    if (actualModel) {
        return actualModel
    }
    return session.modelMode || 'default'
}
