import type { Session } from '../session'
import type { SessionHookData } from './startHookServer'

type CompactionSession = Pick<Session, 'sessionId'> & {
    client: Pick<Session['client'], 'sendSessionEvent'>
}

export function forwardClaudeAutoCompactionStart(
    session: CompactionSession | null,
    sessionId: string,
    data: SessionHookData
): void {
    if (
        !session
        || session.sessionId !== sessionId
        || data.agent_id !== undefined
        || data.hook_event_name !== 'PreCompact'
        || data.trigger !== 'auto'
    ) return

    // Status/boundary messages remain owned by the stream/transcript handlers.
    // A start says nothing about the eventual outcome (including abort/retry).
    session.client.sendSessionEvent({ type: 'message', message: '📦 Compaction started' })
}
