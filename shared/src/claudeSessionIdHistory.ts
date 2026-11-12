/**
 * Claude rotates its native session id on some resumes and local↔remote
 * switches. A HAPI session keeps every id it has owned so a later resume by an
 * older id still finds it. History never contains the current id.
 */

export const CLAUDE_SESSION_ID_HISTORY_LIMIT = 32

function normalize(ids: readonly unknown[], currentId: string | undefined): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const id of ids) {
        if (typeof id !== 'string') continue
        const trimmed = id.trim()
        if (!trimmed || trimmed === currentId || seen.has(trimmed)) continue
        seen.add(trimmed)
        result.push(trimmed)
    }
    // Keep the most recent entries (history is ordered oldest → newest).
    return result.slice(-CLAUDE_SESSION_ID_HISTORY_LIMIT)
}

function readHistory(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

/** History after the session's Claude id changes from `previousId` to `nextId`. */
export function appendClaudeSessionIdHistory(
    history: readonly string[] | undefined,
    previousId: string | undefined,
    nextId: string
): string[] {
    return normalize([...(history ?? []), ...(previousId ? [previousId] : [])], nextId)
}

/**
 * History for the surviving metadata when `source` is merged into `target`:
 * union of both histories plus the source's current id. Returns null when the
 * target already has exactly that history (idempotent for retried merges).
 */
export function mergeClaudeSessionIdHistory(
    source: Record<string, unknown>,
    target: Record<string, unknown>
): string[] | null {
    const targetCurrent = typeof target.claudeSessionId === 'string' ? target.claudeSessionId : undefined
    const sourceCurrent = typeof source.claudeSessionId === 'string' ? source.claudeSessionId : undefined
    const existing = readHistory(target.claudeSessionIdHistory)
    const merged = normalize(
        [...readHistory(source.claudeSessionIdHistory), ...(sourceCurrent ? [sourceCurrent] : []), ...existing],
        targetCurrent
    )
    if (merged.length === 0) return null
    if (merged.length === existing.length && merged.every((id, index) => id === existing[index])) return null
    return merged
}

/** True when `agentSessionId` is the metadata's current or a historical Claude id. */
export function matchesClaudeSessionId(
    metadata: { claudeSessionId?: string; claudeSessionIdHistory?: readonly string[] } | null | undefined,
    agentSessionId: string
): 'current' | 'historical' | null {
    if (!metadata) return null
    if (metadata.claudeSessionId === agentSessionId) return 'current'
    if (metadata.claudeSessionIdHistory?.includes(agentSessionId)) return 'historical'
    return null
}
