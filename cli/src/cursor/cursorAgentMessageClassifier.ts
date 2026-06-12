export type CursorAgentStreamFailureKind =
    | 'quota_exhausted'
    | 'canceled'
    | 'deadline_exceeded'
    | 'unavailable'
    | 'connection_stalled'
    | 'context_window'
    | 'capacity_exhausted'
    | 'unknown_t_prefix'

export type CursorAgentStreamFailure = {
    kind: CursorAgentStreamFailureKind
    transient: boolean
    raw: string
}

type Pattern = {
    test: (text: string) => boolean
    kind: CursorAgentStreamFailureKind
    transient: boolean
}

// Patterns are anchored to the start of the (whitespace-trimmed) message
// because cursor-agent error emits are the whole message body, often with
// leading newlines from ACP transport formatting (observed in real session
// b52b9117: the message text was "\n\nError: T: WritableIterable is closed",
// which was missed when patterns only saw raw start-of-string). Anchoring
// also rejects assistant messages that merely *describe* the patterns in
// prose (the 2026-06-12 self-own where my own response triggered the
// classifier because it listed the pattern strings). trimStart() on every
// pattern keeps the contract consistent across the family.
const PATTERNS: Pattern[] = [
    {
        test: (t) => /^Error: T: \[resource_exhausted\]/i.test(t.trimStart()),
        kind: 'quota_exhausted',
        transient: false
    },
    {
        test: (t) => /^Error: T: \[canceled\]/i.test(t.trimStart()),
        kind: 'canceled',
        transient: true
    },
    {
        test: (t) => /^Error: T: \[deadline_exceeded\]/i.test(t.trimStart()),
        kind: 'deadline_exceeded',
        transient: true
    },
    {
        test: (t) => /^Error: T: \[unavailable\]/i.test(t.trimStart()),
        kind: 'unavailable',
        transient: true
    },
    {
        test: (t) => /^Error: T: Connection stalled/i.test(t.trimStart()),
        kind: 'connection_stalled',
        transient: true
    },
    {
        test: (t) => /^Gemini prompt failed:.*token count exceeds/i.test(t.trimStart()),
        kind: 'context_window',
        transient: false
    },
    {
        test: (t) => /^Gemini prompt failed:.*exhausted your capacity/i.test(t.trimStart()),
        kind: 'capacity_exhausted',
        transient: false
    },
    // catch-all for unknown `Error: T:` prefixes — placed last
    {
        test: (t) => /^Error: T:/i.test(t.trimStart()),
        kind: 'unknown_t_prefix',
        transient: false
    }
]

/**
 * Returns a failure descriptor when the message text matches a known
 * cursor-agent inline model error pattern, or null for benign messages.
 */
export function classifyCursorAgentMessage(text: string): CursorAgentStreamFailure | null {
    for (const pattern of PATTERNS) {
        if (pattern.test(text)) {
            return { kind: pattern.kind, transient: pattern.transient, raw: text }
        }
    }
    return null
}

const PRIOR_DONE_PREFIXES = ['done', 'all done', 'committed', 'successfully', 'fixed', 'complete']

/**
 * Returns true when the text looks like the agent claimed task completion
 * (e.g. "Done.", "All done.", "Successfully committed.").
 */
export function isCompletionClaim(text: string): boolean {
    const lower = text.trim().toLowerCase()
    return PRIOR_DONE_PREFIXES.some((prefix) => lower.startsWith(prefix))
}
