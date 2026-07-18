import type { Session } from '@/types/api'

export function canChangeSessionPermissionMode(
    session: Pick<Session, 'active' | 'agentState'>,
): boolean {
    return session.active && session.agentState?.controlledByUser !== true
}
