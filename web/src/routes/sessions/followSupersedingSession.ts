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
