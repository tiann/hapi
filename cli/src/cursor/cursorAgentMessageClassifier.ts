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

// Patterns are anchored to the start of A LINE (multiline `m` flag), not
// just start-of-string. Three real cursor-agent failure shapes drove this:
//
//   1. Whole-body emit (session b52b9117, 2026-06-12):
//        "\n\nError: T: WritableIterable is closed"
//      -- start of message, after leading whitespace.
//
//   2. Mid-stream append (session e7d9b44b, 2026-06-13):
//        "Three of the four hit Codex's usage limit (#151, #153, #155) -
//         no code review delivered. Only #157 actually got reviewed.
//         Let me pull the inline comments to see Codex's specific
//         suggestions:\n\nError: T: [resource_exhausted] Error"
//      -- cursor-agent appended the gRPC status to the END of an in-flight
//      text stream rather than rejecting the prompt. Start-of-line `m`
//      anchor catches this: the `\n\n` separator means `Error: T:` is at
//      the start of a new line. Pure start-of-string anchoring missed it.
//
//   3. Prose that DESCRIBES the patterns (2026-06-12 self-own):
//        "Triggers on:\n  - Error: T: [resource_exhausted]\n  - ..."
//      -- each bullet line starts with whitespace+dash, NOT with "Error:".
//      Multiline `^Error:` rejects it.
//
//   4. RetriableError prefix (session 0e04ebe7, 2026-06-20):
//        "\n\nError: RetriableError: [canceled] http/2 stream closed..."
//      -- same gRPC bracket notation as `Error: T:` but cursor-agent
//      sometimes stringifies via RetriableError instead. Still a Cursor
//      ACP session; HAPI persists agent messages in a codex-shaped
//      envelope (`convertAgentMessage`) which is NOT the Codex runner.
//
// The diagnostic strength is in the `[snake_case]` bracket form (gRPC's
// stable status notation) and `Error: T:` prefix - both characteristic of
// cursor-agent's runtime stringification, rare in genuine prose. The
// catch-all `Error: T:` is intentionally narrow enough that benign mention
// would have to literally start a line with "Error: T:" - documented
// trade-off, the false-positive surface is small and recoverable
// (operator dismisses banner). The miss surface (this exact failure
// class going unflagged) is much worse.
// `^[ \t]*` allows horizontal whitespace before the marker (covers
// session b52b9117's "  Error: T: [canceled]" wire format with leading
// spaces). It does NOT allow `\n` consumption, so multi-line strings
// only match where the marker actually sits at the start of a line.
// Bullet-list prose like "  - Error: T: ..." still rejects: after
// `[ \t]*` consumes the spaces, the next char is `-`, not `Error`.
const PATTERNS: Pattern[] = [
    {
        test: (t) => /^[ \t]*Error: T: \[resource_exhausted\]/im.test(t)
            || /^[ \t]*Error: RetriableError: \[resource_exhausted\]/im.test(t),
        kind: 'quota_exhausted',
        transient: false
    },
    {
        test: (t) => /^[ \t]*Error: T: \[canceled\]/im.test(t)
            || /^[ \t]*Error: RetriableError: \[canceled\]/im.test(t),
        kind: 'canceled',
        transient: true
    },
    {
        test: (t) => /^[ \t]*Error: T: \[deadline_exceeded\]/im.test(t)
            || /^[ \t]*Error: RetriableError: \[deadline_exceeded\]/im.test(t),
        kind: 'deadline_exceeded',
        transient: true
    },
    {
        test: (t) => /^[ \t]*Error: T: \[unavailable\]/im.test(t)
            || /^[ \t]*Error: RetriableError: \[unavailable\]/im.test(t),
        kind: 'unavailable',
        transient: true
    },
    {
        test: (t) => /^[ \t]*Error: T: Connection stalled/im.test(t)
            || /^[ \t]*Error: RetriableError: Connection stalled/im.test(t),
        kind: 'connection_stalled',
        transient: true
    },
    {
        test: (t) => /^[ \t]*Gemini prompt failed:.*token count exceeds/im.test(t),
        kind: 'context_window',
        transient: false
    },
    {
        test: (t) => /^[ \t]*Gemini prompt failed:.*exhausted your capacity/im.test(t),
        kind: 'capacity_exhausted',
        transient: false
    },
    // catch-all for unknown `Error: T:` / `Error: RetriableError:` prefixes — placed last
    {
        test: (t) => /^[ \t]*Error: T:/im.test(t)
            || /^[ \t]*Error: RetriableError:/im.test(t),
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
