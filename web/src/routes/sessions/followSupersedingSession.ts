import { retargetSharePendingTransfer } from '@/lib/sharePendingState'

export function getSupersedingSessionId(
    currentSessionId: string,
    metadata: { supersededBySessionId?: string } | null | undefined
): string | null {
    const replacement = metadata?.supersededBySessionId?.trim()
    if (!replacement || replacement === currentSessionId) {
        return null
    }
    return replacement
}

export function shouldFollowSupersedingSession(
    previous: { sessionId: string; supersedingSessionId: string | null } | null,
    currentSessionId: string,
    metadata: { supersededBySessionId?: string } | null | undefined
): boolean {
    return previous?.sessionId === currentSessionId
        && previous.supersedingSessionId === null
        && getSupersedingSessionId(currentSessionId, metadata) !== null
}

/**
 * Side effects that must run before navigating A → B on automatic
 * supersession. Keeps a share-target pending transfer bound to the live
 * session id so ShareSeedConsumer on B can still claim it.
 */
export function prepareFollowSupersedingSession(
    fromSessionId: string,
    toSessionId: string,
): void {
    retargetSharePendingTransfer(fromSessionId, toSessionId)
}
