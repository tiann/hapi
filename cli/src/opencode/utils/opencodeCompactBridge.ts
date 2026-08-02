export type OpencodeCompactResult =
    | { ok: true; summaryText?: string }
    | { ok: false; error: string };

export type CompactionResult =
    | { status: 'success'; text: string }
    | { status: 'failed'; reason: string }
    | { status: 'unverified'; reason: string };

export type CompactionMarkerSnapshot = {
    markerIds: string[];
};

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
 * been wired up but the result-verification GET (which runs right
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

type OpencodeMessagePart = { type?: unknown; text?: unknown; auto?: unknown };
type OpencodeMessageEntry = {
    info?: {
        id?: unknown;
        role?: unknown;
        parentID?: unknown;
        summary?: unknown;
        finish?: unknown;
        error?: unknown;
    };
    parts?: unknown;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isAssistant(entry: OpencodeMessageEntry | undefined): boolean {
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

function isManualCompactionMarker(entry: OpencodeMessageEntry): boolean {
    return Array.isArray(entry.parts)
        && entry.parts.some((part) => isObjectRecord(part) && part.type === 'compaction' && part.auto === false);
}

function getManualCompactionMarkerIds(entries: OpencodeMessageEntry[]): string[] | null {
    const markerIds: string[] = [];
    for (const entry of entries) {
        if (!isManualCompactionMarker(entry)) continue;
        if (typeof entry.info?.id !== 'string') return null;
        markerIds.push(entry.info.id);
    }
    return markerIds;
}

function isTerminal(entry: OpencodeMessageEntry): boolean {
    // OpenCode/provider finish strings are not an enum HAPI owns. Any
    // nonblank string is terminal evidence; an allowlist would reject valid
    // provider-specific values such as the observed `unknown` finish.
    return typeof entry.info?.finish === 'string' && entry.info.finish.trim().length > 0;
}

function safeErrorReason(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    // OpenCode persists provider failures as `{ name, data: { message, ... } }`.
    // Read only that scalar message: serializing error/data would risk exposing
    // request headers, provider metadata, or other sensitive fields.
    const message = typeof value === 'string'
        ? value
        : isObjectRecord(value) && isObjectRecord(value.data) && typeof value.data.message === 'string'
            ? value.data.message
            : null;
    if (!message) return 'OpenCode reported a compaction error.';
    const normalized = message.trim().replace(/\s+/g, ' ');
    return normalized ? normalized.slice(0, 200) : 'OpenCode reported a compaction error.';
}

async function fetchSessionMessages(opts: OpencodeCompactCallOpts & { fetchImpl?: FetchLike }): Promise<OpencodeMessageEntry[] | null> {
    const fetchFn: FetchLike = opts.fetchImpl ?? fetch;
    const url = `${opts.baseUrl}/session/${encodeURIComponent(opts.sessionId)}/message`;
    try {
        const response = await fetchFn(url, { method: 'GET', signal: opts.signal });
        if (!response.ok) return null;
        const data: unknown = await response.json().catch(() => null);
        return Array.isArray(data) ? data as OpencodeMessageEntry[] : null;
    } catch {
        return null;
    }
}

/**
 * Captures manual compaction markers before the summarize POST. The
 * post-request verifier uses this boundary instead of selecting the newest
 * marker, which would misattribute an older or later manual compaction.
 */
export async function captureCompactionMarkerSnapshot(opts: OpencodeCompactCallOpts & {
    fetchImpl?: FetchLike;
}): Promise<CompactionMarkerSnapshot | null> {
    const entries = await fetchSessionMessages(opts);
    if (!entries) return null;
    const markerIds = getManualCompactionMarkerIds(entries);
    return markerIds ? { markerIds } : null;
}

/**
 * Resolves only the persisted assistant result associated with this exact
 * summarize request. HTTP 200 merely proves the endpoint returned; it is not
 * success evidence. Unknown shapes, absent association, and non-terminal
 * messages remain unverified rather than becoming a false completion.
 */
export async function fetchCompactionResult(opts: OpencodeCompactCallOpts & {
    markerIdsBefore: readonly string[] | null;
    fetchImpl?: FetchLike;
}): Promise<CompactionResult> {
    if (!opts.markerIdsBefore) {
        return { status: 'unverified', reason: 'Compaction result could not be verified.' };
    }

    const entries = await fetchSessionMessages(opts);
    if (!entries) {
        return { status: 'unverified', reason: 'Compaction result could not be verified.' };
    }

    const markerIds = getManualCompactionMarkerIds(entries);
    if (!markerIds) {
        return { status: 'unverified', reason: 'Compaction result could not be verified.' };
    }

    const before = new Set(opts.markerIdsBefore);
    const newMarkerIds = markerIds.filter((markerId) => !before.has(markerId));
    if (newMarkerIds.length !== 1) {
        return { status: 'unverified', reason: 'Compaction result could not be verified.' };
    }

    const linkedResults = entries.filter((entry) =>
        isAssistant(entry) && entry.info?.parentID === newMarkerIds[0]
    );
    if (linkedResults.length !== 1) {
        return { status: 'unverified', reason: 'Compaction result could not be verified.' };
    }

    const result = linkedResults[0]!;
    const error = safeErrorReason(result.info?.error);
    if (error) {
        return { status: 'failed', reason: error };
    }

    const text = extractTextPart(result);
    if (isTerminal(result) && (!text || text.trim().length === 0)) {
        return { status: 'failed', reason: 'OpenCode returned an empty compaction summary.' };
    }

    if (result.info?.summary === true && isTerminal(result) && text && text.trim().length > 0) {
        return { status: 'success', text };
    }

    return { status: 'unverified', reason: 'Compaction result could not be verified.' };
}
