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

const PATTERNS: Pattern[] = [
    {
        test: (t) => /^Error: T: \[resource_exhausted\]/i.test(t),
        kind: 'quota_exhausted',
        transient: false
    },
    {
        test: (t) => /^Error: T: \[canceled\]/i.test(t),
        kind: 'canceled',
        transient: true
    },
    {
        test: (t) => /^Error: T: \[deadline_exceeded\]/i.test(t),
        kind: 'deadline_exceeded',
        transient: true
    },
    {
        test: (t) => /^Error: T: \[unavailable\]/i.test(t),
        kind: 'unavailable',
        transient: true
    },
    {
        test: (t) => /^Error: T: Connection stalled/i.test(t),
        kind: 'connection_stalled',
        transient: true
    },
    // Anchor Gemini patterns to start of message: real cursor-agent error
    // emits are the whole message body, not embedded in prose. Loose
    // "contains" matching false-positives on assistant messages that merely
    // *describe* the pattern (e.g. release notes, doc copy, help text, an
    // assistant explaining how the classifier works). See regression test
    // "does not classify prose that describes the pattern".
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
        test: (t) => /^Error: T:/i.test(t),
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
