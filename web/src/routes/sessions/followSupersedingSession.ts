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
