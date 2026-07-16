import type { ChatToolCall } from '@/chat/types'

/**
 * Wall-clock duration of a tool call in milliseconds, or null when it cannot be
 * derived. Uses the Claude entry's own execution-machine timestamps
 * (`execStartedAt`/`execCompletedAt`) — which reflect the true tool execution
 * time without the hub receive/queue overhead — but only when *both* are
 * present. This both-or-neither rule is deliberate: mixing one real Claude
 * timestamp with one hub-received time subtracts two different clocks and
 * silently yields a wrong duration (positive skew inflates it; only negative
 * skew is caught by the guard below). When either exec timestamp is missing
 * (e.g. a hub-synthesized tool_result for a denied/timed-out/cancelled tool, a
 * malformed entry, or a non-Claude agent flavor), we fall back to the hub
 * receive times on *both* sides so the subtraction stays clock-consistent.
 * Returns null for pending/running tools (no completed end) and guards against
 * clock skew where the end precedes the start.
 */
export function toolDurationMs(tool: ChatToolCall): number | null {
    const useExec = tool.execStartedAt != null && tool.execCompletedAt != null
    const end = useExec ? tool.execCompletedAt : tool.completedAt
    if (end == null) return null
    const start = useExec ? tool.execStartedAt : (tool.startedAt ?? tool.createdAt)
    if (start == null) return null
    const duration = end - start
    if (duration < 0) return null
    return duration
}
