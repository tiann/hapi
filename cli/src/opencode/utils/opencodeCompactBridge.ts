export type OpencodeCompactResult =
    | { ok: true; summaryText?: string }
    | { ok: false; error: string };

export type CompactionSummaryResult =
    | { found: true; text: string }
    | { found: false };

/** Minimal fetch-shaped function signature, kept narrower than `typeof fetch` so tests can pass a plain `vi.fn()` without matching runtime-specific extras (e.g. Bun's `fetch.preconnect`). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * `RequestInit` extended with Bun's non-standard `timeout` fetch option
 * (absent from `bun-types` / the standard fetch typings — see the
 * `triggerOpencodeCompact` doc comment for why it's needed). Narrower than
 * `Record<string, unknown>` so the cast below can't silently accept an
 * unrelated typo'd option name.
 */
type BunFetchInit = RequestInit & { timeout?: false };

/**
 * Every OpenCode-side HTTP call `runCompactOperation()` in
 * opencodeRemoteLauncher.ts makes on behalf of a single /compact operation
 * must extend this — `signal` is **required**, not optional. That launcher
 * owns exactly one `AbortController` for the operation's whole lifecycle
 * (`compactAbortController`, aborted by `handleAbort()` on Stop/switch/exit)
 * and threads its `.signal` through every step so a user-initiated
 * interruption actually reaches whichever HTTP call happens to be in flight
 * at the time.
 *
 * This was previously opt-in (`signal?: AbortSignal`) on each function
 * individually, which is exactly how a real regression happened: a second
 * PR-review round later found that `triggerOpencodeCompact` (the POST) had
 * been wired up but `fetchCompactionSummary` (the GET that runs right
 * after it) had not, because nothing forced it. Making `signal` a required
 * field of a shared base type means the compiler catches a future third
 * HTTP step *implemented as a function in this file* without one — it can't
 * stop someone from bypassing this file entirely with an inline `fetch()`
 * call in `runCompactOperation()`, so this is a guardrail for the pattern
 * this file establishes, not an architectural boundary enforced repo-wide.
 */
export type OpencodeCompactCallOpts = {
    baseUrl: string;
    sessionId: string;
    signal: AbortSignal;
};

/**
 * Splits an ACP-reported combined model id (e.g. `"ollama/qwen3.6:35b-a3b-q8_0-mtp"`)
 * into the separate `providerId`/`modelId` pair required by OpenCode's internal
 * `POST /session/:id/summarize` payload. Only the first `/` is treated as the
 * separator — model ids may themselves contain slashes (e.g. OpenRouter-style
 * `"openrouter/anthropic/claude-sonnet-4-5"`).
 */
export function splitProviderModel(combined: string | null | undefined): { providerId: string; modelId: string } | null {
    if (!combined) return null;
    const separatorIndex = combined.indexOf('/');
    if (separatorIndex <= 0 || separatorIndex === combined.length - 1) return null;
    return {
        providerId: combined.slice(0, separatorIndex),
        modelId: combined.slice(separatorIndex + 1)
    };
}

/**
 * Triggers OpenCode's native AI-compaction for a session by calling the
 * legacy `POST /session/:id/summarize` route on the `opencode acp`
 * subprocess's internal HTTP API.
 *
 * This is NOT `POST /api/session/:id/compact` — that v2-API route is an
 * unimplemented stub in opencode 1.18.9 and always returns 503
 * ("Session compact is not available yet"). `summarize` is the route that
 * actually performs native AI compaction (verified 2026-07-30: triggering it
 * appends a real `{"type":"compaction"}` message part to the session, and
 * streams `agent_thought_chunk` ACP notifications while the model works).
 *
 * `providerID`/`modelID` are required by the endpoint (400 if omitted).
 * The response can legitimately take several minutes to arrive for slow
 * models, so by default no deadline is applied here, mirroring how
 * `AcpSdkBackend.prompt()` uses `timeoutMs: Infinity` for `session/prompt`.
 * `signal` (required — see `OpencodeCompactCallOpts`) is a caller-driven
 * abort, not a deadline, so it's orthogonal to the Bun timeout workaround
 * below (both apply at once).
 *
 * Omitting the `timeout: false` option below is NOT enough under Bun: Bun's
 * global `fetch()` hardcodes its own idle timeout (~5 minutes) that fires
 * independently of any AbortSignal (verified 2026-07-30 via isolated E2E
 * against SER8 — a real ~250s compaction call was killed client-side with
 * "The operation timed out" even with no signal attached; see upstream
 * report oven-sh/bun#16682). The only documented workaround is the
 * non-standard `timeout: false` fetch option Bun itself recognizes (absent
 * from the standard `RequestInit` typings, hence the cast below) — kept
 * unconditionally regardless of `signal` also being set.
 */
export async function triggerOpencodeCompact(opts: OpencodeCompactCallOpts & {
    providerId: string;
    modelId: string;
    fetchImpl?: FetchLike;
}): Promise<OpencodeCompactResult> {
    const fetchFn: FetchLike = opts.fetchImpl ?? fetch;
    const url = `${opts.baseUrl}/session/${encodeURIComponent(opts.sessionId)}/summarize`;

    try {
        const init: BunFetchInit = {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ providerID: opts.providerId, modelID: opts.modelId }),
            // Bun-specific: disables Bun's hardcoded ~5min fetch timeout.
            timeout: false,
            signal: opts.signal
        };
        const response = await fetchFn(url, init as RequestInit);

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            return {
                ok: false,
                error: `OpenCode compact request failed (${response.status}): ${text.slice(0, 300)}`
            };
        }

        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

type OpencodeMessagePart = { type?: unknown; text?: unknown };
type OpencodeMessageEntry = {
    info?: { id?: unknown; role?: unknown; parentID?: unknown; summary?: unknown };
    parts?: unknown;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Only an assistant message is a plausible summary carrier — without this
 * check, an unrelated adjacent/linked entry that happens to carry a `text`
 * part (e.g. another user message) could silently surface as the "summary",
 * bypassing the safe "not found -> skip" fallback this function exists to
 * provide. `info.summary === true` (observed on the real compaction
 * response) is a stronger corroborating signal when present, but role is the
 * one check we always enforce.
 */
function isAssistantSummaryCandidate(entry: OpencodeMessageEntry | undefined): boolean {
    return entry?.info?.role === 'assistant';
}

/** Concatenates every `type:'text'` part in order — a summary can arrive as more than one text segment, and taking only the first would silently truncate it. */
function extractTextPart(entry: OpencodeMessageEntry | undefined): string | null {
    if (!entry || !Array.isArray(entry.parts)) return null;
    const texts = (entry.parts as unknown[])
        .filter((part): part is OpencodeMessagePart => isObjectRecord(part) && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string);
    return texts.length > 0 ? texts.join('') : null;
}

/**
 * After a successful `triggerOpencodeCompact`, OpenCode's session history
 * contains a `{"type":"compaction"}` marker message (role `user`, no text)
 * followed by an assistant message whose `text` part holds the actual
 * summary OpenCode generated (verified 2026-07-30 via isolated E2E: parts
 * were `['step-start','reasoning','text','step-finish']`). This fetches the
 * message list and extracts that text so HAPI can show it as a "Reasoning"
 * block instead of leaving the summary invisible.
 *
 * Looks for the assistant message via its `parentID` pointing at the marker
 * first (robust to the API returning messages in an order other than
 * creation order), falling back to simple positional adjacency (the very
 * next array entry) if no `parentID` link is present. If a session has been
 * compacted more than once, only the most recent marker is considered.
 *
 * Never throws — any failure (network error, unexpected response shape, no
 * marker found, no text part found, or `signal` — see `OpencodeCompactCallOpts`
 * — firing mid-request) resolves to `{ found: false }` so the caller can
 * silently skip showing the summary rather than surfacing an error for what
 * is a purely cosmetic enhancement.
 */
export async function fetchCompactionSummary(opts: OpencodeCompactCallOpts & {
    fetchImpl?: FetchLike;
}): Promise<CompactionSummaryResult> {
    const fetchFn: FetchLike = opts.fetchImpl ?? fetch;
    const url = `${opts.baseUrl}/session/${encodeURIComponent(opts.sessionId)}/message`;

    try {
        const response = await fetchFn(url, { method: 'GET', signal: opts.signal });
        if (!response.ok) return { found: false };

        const data: unknown = await response.json().catch(() => null);
        if (!Array.isArray(data)) return { found: false };
        const entries = data as OpencodeMessageEntry[];

        let markerIndex = -1;
        for (let i = entries.length - 1; i >= 0; i--) {
            const parts = entries[i]?.parts;
            if (Array.isArray(parts) && parts.some((part) => isObjectRecord(part) && part.type === 'compaction')) {
                markerIndex = i;
                break;
            }
        }
        if (markerIndex === -1) return { found: false };

        const markerId = entries[markerIndex]?.info?.id;
        const byParentId = typeof markerId === 'string'
            ? entries.find((entry) => entry.info?.parentID === markerId && isAssistantSummaryCandidate(entry))
            : undefined;

        const positionalCandidate = entries[markerIndex + 1];
        const byPosition = isAssistantSummaryCandidate(positionalCandidate) ? positionalCandidate : undefined;

        const text = extractTextPart(byParentId) ?? extractTextPart(byPosition);
        return text !== null ? { found: true, text } : { found: false };
    } catch {
        return { found: false };
    }
}
