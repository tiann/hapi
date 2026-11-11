/**
 * Builds the chat-visible completion line for a claude /compact turn.
 *
 * The SDK stream carries no summary body for compactions (measured: only a
 * system/compact_boundary with token metadata arrives), so the completion
 * event is the defensive fallback line — pi-style token delta when both
 * numbers are known, bare acknowledgment otherwise.
 */
export function buildCompactCompletionEvent(
    failure: string | null,
    tokensBefore?: number,
    tokensAfter?: number
): string {
    if (failure !== null) {
        return failure.length > 0 ? `📦 Compaction failed: ${failure}` : '📦 Compaction failed'
    }
    if (typeof tokensBefore === 'number' && typeof tokensAfter === 'number') {
        return `📦 Compacted (${tokensBefore} → ${tokensAfter} tokens)`
    }
    return '📦 Compacted'
}
