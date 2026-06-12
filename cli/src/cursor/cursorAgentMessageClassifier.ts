/**
 * Structural-first classifier for cursor-agent failure signals.
 *
 * Sources, in priority order:
 *   1. JSON-RPC rejection on session/prompt (structural: thrown Error from
 *      `@zed-industries/agent-client-protocol` SDK or transport close).
 *   2. Stderr lines parsed by AcpStdioTransport into typed AcpStderrError.
 *   3. Text in agent/message events (last-resort fallback, brittle by nature
 *      because cursor-agent stringifies internal errors as plain prose).
 *
 * The text fallback (1)-(3) only fires when no structural signal already
 * classified the turn. Each source carries a `source` tag so the operator
 * (and tests) can tell where the classification came from.
 */
export type CursorAgentStreamFailureKind =
    // --- text/agent-message classifier kinds (legacy, fallback) ---
    | 'quota_exhausted'
    | 'canceled'
    | 'deadline_exceeded'
    | 'unavailable'
    | 'connection_stalled'
    | 'context_window'
    | 'capacity_exhausted'
    | 'unknown_t_prefix'
    // --- structural kinds ---
    | 'transport_closed'      // ACP transport closed mid-turn (WritableIterable, etc.)
    | 'rpc_timeout'           // sendRequest timeout
    | 'rpc_error'             // JSON-RPC error response from the agent
    | 'agent_crashed'         // process exit during in-flight prompt
    | 'rate_limited'          // stderr-derived rate limit
    | 'auth_failed'           // stderr-derived authentication failure
    | 'model_not_found'       // stderr-derived model-not-found
    | 'unknown_stderr'        // stderr line classified as error but not typed
    | 'prompt_failed'         // catch-all for prompt rejections

export type CursorAgentStreamFailureSource = 'rpc' | 'stderr' | 'text'

export type CursorAgentStreamFailure = {
    kind: CursorAgentStreamFailureKind
    transient: boolean
    raw: string
    source: CursorAgentStreamFailureSource
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
 *
 * NOTE: this is the LAST-RESORT fallback. Prefer structural signals
 * (classifyAcpRpcRejection, mapAcpStderrToFailure) — they fire before
 * this path runs and are not subject to false positives from prose that
 * happens to match the pattern shape.
 */
export function classifyCursorAgentMessage(text: string): CursorAgentStreamFailure | null {
    for (const pattern of PATTERNS) {
        if (pattern.test(text)) {
            return { kind: pattern.kind, transient: pattern.transient, raw: text, source: 'text' }
        }
    }
    return null
}

/**
 * Maps an AcpStderrError (typed by AcpStdioTransport.parseStderrError) to
 * a CursorAgentStreamFailure. Structural: `error.type` is already classified
 * by the transport from the stderr stream, so this is just a name mapping.
 *
 * Accepts a minimal shape of AcpStderrError so this module stays decoupled
 * from the transport package.
 */
export function mapAcpStderrToFailure(error: {
    type: 'rate_limit' | 'model_not_found' | 'authentication' | 'quota_exceeded' | 'unknown'
    raw: string
}): CursorAgentStreamFailure {
    switch (error.type) {
        case 'rate_limit':
            return { kind: 'rate_limited', transient: true, raw: error.raw, source: 'stderr' }
        case 'model_not_found':
            return { kind: 'model_not_found', transient: false, raw: error.raw, source: 'stderr' }
        case 'authentication':
            return { kind: 'auth_failed', transient: false, raw: error.raw, source: 'stderr' }
        case 'quota_exceeded':
            return { kind: 'quota_exhausted', transient: false, raw: error.raw, source: 'stderr' }
        case 'unknown':
        default:
            return { kind: 'unknown_stderr', transient: false, raw: error.raw, source: 'stderr' }
    }
}

/**
 * Inspects an Error thrown by `backend.prompt(...)` (i.e. the JSON-RPC
 * `session/prompt` call) and classifies it.
 *
 * The error sources are STRUCTURAL: thrown by either the
 * `@zed-industries/agent-client-protocol` SDK on transport close, or by
 * `AcpStdioTransport.markClosed` -> `rejectAllPending` on process exit /
 * stream close, or by the JSON-RPC layer on `error.message` from a typed
 * agent-side error response. We do match against `error.message` strings
 * here — but those strings are emitted by code we control or vendor, not
 * by free-text agent prose. The blast radius for false positives is the
 * library's stable error vocabulary, which is much smaller than "any
 * message a cursor-agent might emit."
 *
 * Returns null if the error doesn't look like a model-side failure
 * (e.g. user cancellation, programmer error in our own code) — the
 * caller should still log/surface the error but not fire modelError.
 */
export function classifyAcpRpcRejection(error: unknown): CursorAgentStreamFailure | null {
    const raw = error instanceof Error ? error.message : String(error)
    const lower = raw.toLowerCase()

    // Programmer/user signals that should NOT fire modelError.
    if (lower.includes('aborted') || lower.includes('user cancelled') || lower.includes('user canceled')) {
        return null
    }

    // Transport-level closure: WritableIterable closed, ACP transport closed,
    // or process exited. All come through markClosed() -> rejectAllPending().
    if (
        lower.includes('writableiterable is closed') ||
        lower.includes('acp transport is closed') ||
        lower.includes('acp transport closed') ||
        lower.includes('acp process exited')
    ) {
        return { kind: 'transport_closed', transient: true, raw, source: 'rpc' }
    }

    // Process error during spawn / IO failure during write.
    if (lower.includes('failed to spawn') || lower.includes('epipe') || lower.includes('ecanceled')) {
        return { kind: 'agent_crashed', transient: true, raw, source: 'rpc' }
    }

    // Request-level timeout (DEFAULT_TIMEOUT_MS in AcpStdioTransport).
    if (lower.includes('timed out after') || lower.includes('timeout')) {
        return { kind: 'rpc_timeout', transient: true, raw, source: 'rpc' }
    }

    // The text-classifier patterns are also worth running on RPC error
    // bodies, because cursor-agent sometimes returns the gRPC status as a
    // JSON-RPC `error.message` instead of stringifying it as a text
    // message. Map those through with source='rpc' so the operator sees
    // it came from a structural signal, not from free-text matching.
    const textMatch = classifyCursorAgentMessage(raw)
    if (textMatch) {
        return { ...textMatch, source: 'rpc' }
    }

    // Catch-all: the prompt rejected for SOME reason. Conservative:
    // fire modelError as 'prompt_failed' (non-transient) so the operator
    // sees the turn was degraded.
    return { kind: 'prompt_failed', transient: false, raw, source: 'rpc' }
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
