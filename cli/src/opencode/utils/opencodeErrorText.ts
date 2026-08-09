import { asString, isObject } from '@hapi/protocol';

/**
 * Longest run of provider-authored text this session puts in front of a user.
 *
 * OpenCode does not bound what it forwards: a provider that answers a rate
 * limit with a 20KB body produces a `session/prompt` error message of 20,210
 * characters verbatim (measured against opencode 1.18.15). That is not an
 * error report, it is a wall — it buries the one sentence that matters, and
 * every copy of it is persisted in the hub's message store and replayed to
 * every client that opens the session.
 *
 * 200 is not a fresh guess: it is the cap `safeErrorReason()` in
 * opencodeCompactBridge.ts already applies to the same kind of value (the
 * provider message OpenCode persists on a failed compaction), so the two
 * places this session shows provider text agree. Real messages are far
 * shorter — the rate-limit report this feature was built for is 79
 * characters.
 */
export const OPENCODE_PROVIDER_TEXT_MAX_LENGTH = 200;

/** Shown when the failure carries nothing readable; preserved verbatim from before this text was wired through, so that path is a strict no-op. */
const OPENCODE_PROMPT_FAILED_FALLBACK = 'OpenCode prompt failed. Check logs for details.';

/**
 * The JSON-RPC layer's own wrapper, and the marker that a rejection carries
 * agent-authored text at all.
 *
 * OpenCode maps every unhandled service failure to code -32603 and prefixes
 * the provider's text with this, so it appears on messages that have nothing
 * internal about them ("Internal error: Rate limit exceeded…"). It describes
 * the transport, tells the reader nothing, and pushes the actual reason past
 * the fold on a phone — so it is stripped before display.
 *
 * Requiring it is what keeps this an allowlist. `AcpStdioTransport` flattens
 * a JSON-RPC error response to `new Error(response.error.message)`, losing
 * `code` and `data`, so by the time the launcher catches a rejection it
 * cannot tell one apart from an error the transport built itself — and those
 * are not agent-authored. The process-close error appends up to 4KB of raw
 * subprocess stderr to its message, which must never reach a remote
 * timeline; the timeout error names an internal method and duration. Neither
 * carries this wrapper. Anything without it falls back to
 * {@link OPENCODE_PROMPT_FAILED_FALLBACK}, which is what this path rendered
 * before, so an unrecognised shape degrades to the old behaviour rather than
 * publishing whatever it happened to contain.
 */
const JSON_RPC_INTERNAL_ERROR_PREFIX = /^internal error:\s*/i;

/**
 * One displayable line: every whitespace run (including newlines a provider
 * embedded) collapsed to a single space.
 *
 * Exported for the same reason {@link OPENCODE_PROVIDER_TEXT_MAX_LENGTH} is:
 * the event stream relays provider text to the same surfaces under the same
 * one-line contract, and two copies of this rule would drift.
 */
export function collapseWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Caps provider-authored text at {@link OPENCODE_PROVIDER_TEXT_MAX_LENGTH}.
 *
 * The ellipsis is load-bearing rather than decoration: a rate-limit message
 * cut mid-sentence without one reads as a complete (and different) statement
 * from the provider.
 */
export function truncateOpencodeProviderText(text: string): string {
    if (text.length <= OPENCODE_PROVIDER_TEXT_MAX_LENGTH) {
        return text;
    }
    return `${text.slice(0, OPENCODE_PROVIDER_TEXT_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * The agent's own words behind a failed `session/prompt`, as one line, with
 * the JSON-RPC wrapper stripped — or null when the rejection is not one
 * OpenCode authored.
 *
 * Not truncated here; {@link formatOpencodePromptError} applies the cap at
 * the point of display.
 *
 * Only `message` is read, and only when it carries
 * {@link JSON_RPC_INTERNAL_ERROR_PREFIX}. That pairing is the whole safety
 * property: the wrapper says the text came back over the wire from OpenCode,
 * and that channel is sanitised — probed with a stub provider answering
 * `Authorization: Bearer …`, `Set-Cookie: …` and a 4KB body, the ACP error
 * carried none of them, only the provider's message text. (The same failure
 * also appears on OpenCode's `/event` stream as `session.error`, where all of
 * it *is* present verbatim — which is exactly why the event subscription does
 * not read that event.)
 */
function extractOpencodePromptErrorText(error: unknown): string | null {
    const raw = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : isObject(error)
                ? asString(error.message)
                : null;
    if (raw === null) return null;
    const collapsed = collapseWhitespace(raw);
    if (!JSON_RPC_INTERNAL_ERROR_PREFIX.test(collapsed)) return null;
    const text = collapsed.replace(JSON_RPC_INTERNAL_ERROR_PREFIX, '').trim();
    return text || null;
}

/** Prefix {@link formatOpencodePromptError} puts in front of the provider's text. */
const OPENCODE_PROMPT_FAILED_PREFIX = 'OpenCode prompt failed: ';

/**
 * Renders the failure of an OpenCode `session/prompt` for the user.
 *
 * The reason was never missing — `AcpStdioTransport` rejects the pending
 * request with the JSON-RPC `error.message` verbatim, which is where the
 * provider's own explanation lives. The launcher used to catch that, log it,
 * and hand the user a fixed "check logs for details" string instead. A
 * remote user is by definition not at the machine holding those logs, so
 * that read as "it stopped, and you may not know why".
 *
 * The old wording is kept as the prefix rather than replaced, so an operator
 * who has learned to grep for "OpenCode prompt failed" still finds it, and
 * a failure with nothing readable to say renders exactly the sentence it
 * always did.
 */
export function formatOpencodePromptError(error: unknown): string {
    const message = extractOpencodePromptErrorText(error);
    return message
        ? `${OPENCODE_PROMPT_FAILED_PREFIX}${truncateOpencodeProviderText(message)}`
        : OPENCODE_PROMPT_FAILED_FALLBACK;
}
