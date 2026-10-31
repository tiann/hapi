import { listChildPids } from './opencodeBackend';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function readFileUtf8(path: string): Promise<string> {
    return readFile(path, 'utf8');
}

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

/**
 * v2 variant of `triggerOpencodeCompact` for opencode 2.x: the internal API
 * was redesigned (verified 2026-10-15 against 2.0.29) — `POST /api/session/
 * :id/compact` replaces `/session/:id/summarize`, and Basic Auth is now
 * required (username `opencode`, password from the acp parent's
 * `OPENCODE_PASSWORD` env). Non-2xx responses throw (the launcher's v2
 * compact path has no result-verification GET to coordinate with, unlike the
 * v1 `{ok:false}` contract).
 *
 * Like the v1 path, `timeout: false` (Bun-only fetch option) disables Bun's
 * hardcoded ~5min idle timeout — compaction can legitimately take minutes.
 */
export type OpencodeCompactV2Admission =
    | { kind: 'admitted'; compactionId: string | null }
    | { kind: 'rejected'; error: string }
    | { kind: 'transport-error'; message: string };

export async function triggerOpencodeCompactV2(opts: OpencodeCompactCallOpts & {
    providerId: string;
    modelId: string;
    password: string;
    fetchImpl?: FetchLike;
}): Promise<OpencodeCompactV2Admission> {
    const fetchFn: FetchLike = opts.fetchImpl ?? fetch;
    const url = `${opts.baseUrl}/api/session/${encodeURIComponent(opts.sessionId)}/compact`;
    const init: BunFetchInit = {
        method: 'POST',
        headers: {
            authorization: 'Basic ' + Buffer.from(`opencode:${opts.password}`).toString('base64'),
            'content-type': 'application/json'
        },
        // v2.0.29 compact payload schema is {id?, delivery?} with
        // additionalProperties: false (packages/protocol/openapi.json) — the
        // session's current model governs server-side, so no provider/model
        // fields are sent.
        body: JSON.stringify({}),
        // Bun-specific: disables Bun's hardcoded ~5min fetch timeout.
        timeout: false,
        signal: opts.signal
    };
    let response: Response;
    try {
        response = await fetchFn(url, init as RequestInit);
    } catch (error) {
        // Transport-level failure: admission is UNCERTAIN — the server may
        // have accepted the request before the connection died. The caller
        // must run identity recovery instead of treating this as a
        // definitive rejection.
        return { kind: 'transport-error', message: error instanceof Error ? error.message : String(error) };
    }
    if (!response.ok) {
        // 4xx: the server answered and refused — definitive, nothing was
        // admitted. 5xx: the server may have admitted the compaction and
        // then failed while processing it (side effects already created) —
        // admission is UNCERTAIN, so recovery (not failure) applies.
        const text = await response.text().catch(() => '');
        if (response.status >= 500) {
            return { kind: 'transport-error', message: `OpenCode v2 compact request failed after admission risk (${response.status}): ${text.slice(0, 300)}` };
        }
        return { kind: 'rejected', error: `OpenCode v2 compact request failed (${response.status}): ${text.slice(0, 300)}` };
    }
    // The admitted compaction message echoes back in the response body
    // (measured 2026-10-16: { data: { id: 'msg_…', type: 'compaction', … } }).
    // Its id is the correlation key for verification polling.
    try {
        const payload: unknown = await response.json();
        const record = isObjectRecord(payload) && isObjectRecord(payload.data) ? payload.data : null;
        const id = record && typeof record.id === 'string' ? record.id : null;
        return { kind: 'admitted', compactionId: id };
    } catch {
        return { kind: 'admitted', compactionId: null };
    }
}

/**
 * v2 compact POST returns as soon as the compaction marker is created; the
 * summary itself is produced asynchronously by the server (verified
 * 2026-10-16 against 2.0.29: the immediate follow-up GET carries no
 * assistant result). So, unlike the v1 path — whose POST blocks until
 * completion and needs a single verification GET — the v2 result must be
 * polled until it stops being `unverified`. There is no hard timeout,
 * mirroring the v1 philosophy of waiting indefinitely for real compaction
 * (compaction can legitimately take minutes). `signal` aborts the wait
 * immediately with the current status (the launcher's isCancelled check
 * suppresses the result on abort anyway); without a signal this just polls.
 */
export async function pollCompactionResultV2(opts: {
    baseUrl: string;
    sessionId: string;
    password: string;
    signal?: AbortSignal;
    /** Correlation id of the admitted compaction (see fetchCompactionResultV2). */
    expectedCompactionId?: string | null;
    /** Pre-POST compaction ids excluded from identity recovery (see fetchCompactionResultV2). */
    excludeCompactionIds?: string[] | null;
    pollIntervalMs?: number;
    /**
     * Stall cap, not a total cap. The poll runs inside the FIFO barrier
     * (phase 'summarize'), so an entry that never appears must not hold the
     * session forever: past this many consecutive rounds WITHOUT observing
     * the matched compaction (no pending progress signal), the loop gives up
     * with the last unverified result (~10 minutes at the default interval),
     * matching v1 where a stalled blocking POST eventually errors out. A
     * visible pending compaction is genuine server work — it resets the
     * stall counter, and the escape hatch remains switch/exit.
     */
    maxAttempts?: number;
    delayImpl?: (ms: number) => Promise<void>;
    fetchImpl?: FetchLike;
}): Promise<CompactionResult> {
    const pollIntervalMs = opts.pollIntervalMs ?? 5000;
    const maxAttempts = opts.maxAttempts ?? 120;
    const wait = opts.delayImpl ?? (async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
    let stalledRounds = 0;
    let ambiguousTerminal = false;
    // Once the admitted compaction has been OBSERVED in a non-terminal
    // state, server work is confirmed running: the stall cap must not
    // license releasing the barrier onto it — only a terminal outcome or
    // an explicit teardown ends the wait (escape hatch: switch/exit).
    let sawPending = false;
    for (;;) {
        const result = await fetchCompactionResultV2({
            baseUrl: opts.baseUrl,
            sessionId: opts.sessionId,
            password: opts.password,
            signal: opts.signal,
            expectedCompactionId: opts.expectedCompactionId,
            excludeCompactionIds: opts.excludeCompactionIds,
            onMatchedPending: () => { stalledRounds = 0; sawPending = true; },
            onAmbiguousTerminal: () => { ambiguousTerminal = true; },
            fetchImpl: opts.fetchImpl
        });
        if (result.status !== 'unverified') {
            return result;
        }
        if (ambiguousTerminal) {
            return result;
        }
        stalledRounds += 1;
        if (opts.signal?.aborted) {
            return result;
        }
        if (!sawPending && stalledRounds >= maxAttempts) {
            return result;
        }
        await wait(pollIntervalMs);
        // Abort during the wait must not trigger another fetch round.
        if (opts.signal?.aborted) {
            return result;
        }
    }
}

/**
 * Extracts the OPENCODE_PASSWORD value from a NUL-separated `/proc/<pid>/
 * environ` payload. Exported for fixture tests.
 */
export function parseOpencodeEnvironPassword(environ: string): string | null {
    for (const entry of environ.split('\0')) {
        if (entry.startsWith('OPENCODE_PASSWORD=')) {
            const value = entry.slice('OPENCODE_PASSWORD='.length);
            return value.length > 0 ? value : null;
        }
    }
    return null;
}

/**
 * Extracts the OPENCODE_PASSWORD value from `ps Eww -p <pid>` output (the
 * non-Linux fallback; Eww prints the full environment in COMMAND). Exported
 * for fixture tests.
 */
export function parsePsEnvironPassword(output: string): string | null {
    const match = /(?:^|\s)OPENCODE_PASSWORD=([^\s]+)/.exec(output);
    if (!match) return null;
    return match[1]!.length > 0 ? match[1]! : null;
}

/**
 * Reads the OPENCODE_PASSWORD the v2 `opencode acp` parent generated and
 * injected into its `serve --stdio` child's environment (verified
 * 2026-10-15: the parent acp process's own env does not carry it — only the
 * child's). On Linux, resolves the first child via the per-task `children`
 * files under `/proc/<acpPid>/task/`; elsewhere falls back to `pgrep -P` +
 * `ps Eww`. Returns null on
 * any failure — callers disable the v2 compact bridge rather than guessing.
 */
export async function readOpencodeV2ServerPassword(acpPid: number, opts?: {
    platform?: NodeJS.Platform;
    listDescendantPids?: (acpPid: number) => Promise<number[]>;
    readChildEnviron?: (childPid: number) => Promise<string>;
    readChildCmdline?: (childPid: number) => Promise<string>;
    execImpl?: (command: string, args: string[]) => Promise<string>;
}): Promise<string | null> {
    const platform = opts?.platform ?? process.platform;
    // Preference order among descendants carrying OPENCODE_PASSWORD: the
    // `serve` process. With an npm wrapper the tree is wrapper → native acp
    // → serve, and a user-exported OPENCODE_PASSWORD is INHERITED by the
    // native child while serve gets the freshly generated one — accepting
    // the first match would report the inherited credential and every
    // /compact would 401.
    const preferServe = (candidates: Array<{ password: string; isServe: boolean }>): string | null => {
        const serve = candidates.find((candidate) => candidate.isServe);
        return (serve ?? candidates[0])?.password ?? null;
    };
    try {
        const descendants = opts?.listDescendantPids ?? (async (pid: number) =>
            await listChildPids(pid, { platform }));
        if (platform === 'linux') {
            const readEnviron = opts?.readChildEnviron ?? (async (childPid: number) =>
                await readFile(`/proc/${childPid}/environ`, 'utf8'));
            const readCmdline = opts?.readChildCmdline ?? (async (childPid: number) =>
                await readFile(`/proc/${childPid}/cmdline`, 'utf8'));
            const candidates: Array<{ password: string; isServe: boolean }> = [];
            for (const childPid of await descendants(acpPid)) {
                try {
                    const password = parseOpencodeEnvironPassword(await readEnviron(childPid));
                    if (!password) continue;
                    const cmdline = await readCmdline(childPid).catch(() => '');
                    // Exact serve argument, not a substring: an executable
                    // under /home/server/ must not flag an `acp` child.
                    candidates.push({ password, isServe: /\bserve\b/.test(cmdline) && /--stdio/.test(cmdline) });
                } catch {
                    // Fall through if this child yields nothing.
                }
            }
            return preferServe(candidates);
        }
        const run = async (command: string, args: string[]): Promise<string> => {
            if (opts?.execImpl) {
                return await opts.execImpl(command, args);
            }
            const { stdout } = await execFileAsync(command, args, { timeout: 5000 });
            return stdout;
        };
        // Iterate EVERY descendant (recursive — the npm wrapper makes serve a
        // grandchild) via a single `ps Eww` per pid, which carries both the
        // environment and the command line.
        const candidates: Array<{ password: string; isServe: boolean }> = [];
        for (const child of await descendants(acpPid)) {
            try {
                const psOutput = await run('ps', ['Eww', '-p', String(child)]);
                const password = parsePsEnvironPassword(psOutput);
                if (!password) continue;
                // `ps Eww` embeds the environment after COMMAND; match `serve`
                // against the command portion only, or an inherited env value
                // containing the substring would misflag the candidate.
                const commandPortion = psOutput.split(/\s+[A-Za-z_][A-Za-z0-9_]*=/)[0] ?? psOutput;
                candidates.push({ password, isServe: /\bserve\b/.test(commandPortion) && /--stdio/.test(commandPortion) });
            } catch {
                // Try the next descendant.
            }
        }
        return preferServe(candidates);
    } catch {
        return null;
    }
}

type OpencodeMessagePart = { type?: unknown; text?: unknown; auto?: unknown };
type OpencodeMessageEntry = {
    id?: unknown;
    type?: unknown;
    status?: unknown;
    reason?: unknown;
    summary?: unknown;
    providerContext?: unknown;
    native?: unknown;
    error?: unknown;
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
    // v2 compaction errors (verified against v2.0.29,
    // packages/schema/src/session-error.ts) are `{ type, message }` — read
    // the top-level message scalar the same way.
    const message = typeof value === 'string'
        ? value
        : isObjectRecord(value) && typeof value.message === 'string'
            ? value.message
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

/**
 * Captures the ids of compaction entries that already exist BEFORE a compact
 * POST — the v2 analogue of v1's `captureCompactionMarkerSnapshot` boundary.
 * Used to recover identity when the POST response cannot be read: any
 * compaction entry appearing afterwards must be ours. Null = the snapshot
 * itself failed (caller then has no recovery basis).
 */
export async function captureCompactionIdsV2(opts: {
    baseUrl: string;
    sessionId: string;
    password: string;
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
}): Promise<string[] | null> {
    const fetchFn: FetchLike = opts.fetchImpl ?? fetch;
    const url = `${opts.baseUrl}/api/session/${encodeURIComponent(opts.sessionId)}/message`;
    try {
        const response = await fetchFn(url, {
            method: 'GET',
            signal: opts.signal,
            headers: {
                authorization: 'Basic ' + Buffer.from(`opencode:${opts.password}`).toString('base64')
            }
        });
        if (!response.ok) return null;
        const payload: unknown = await response.json().catch(() => null);
        const entries = Array.isArray(payload)
            ? payload as OpencodeMessageEntry[]
            : isObjectRecord(payload) && Array.isArray(payload.data)
                ? payload.data as OpencodeMessageEntry[]
                : null;
        if (!entries) return null;
        return entries
            .filter((entry) => entry.type === 'compaction')
            .map((entry) => (isObjectRecord(entry) && typeof entry.id === 'string' ? entry.id : null))
            .filter((id): id is string => id !== null);
    } catch {
        return null;
    }
}

/**
 * v2 counterpart of `fetchCompactionResult`. opencode v2 redesigned the
 * messages endpoint (verified 2026-10-15): `GET /api/session/:id/message`
 * with Basic auth, wrapping the message entries in a `{ data: [...] }`
 * envelope. There is no pre-POST marker snapshot on the v2 path (the v1
 * `captureCompactionMarkerSnapshot` boundary does not exist there), so the
 * newest manual compaction marker in the list is treated as this request's
 * marker and the same v1 parsing rules apply: exactly one assistant result
 * linked to it, terminal only, summary flag required; anything else stays
 * `unverified` rather than becoming a false completion.
 */
export async function fetchCompactionResultV2(opts: {
    baseUrl: string;
    sessionId: string;
    password: string;
    /** Aborts an in-flight messages GET. Required for the poll loop (see pollCompactionResultV2). */
    signal?: AbortSignal;
    /**
     * Correlation id of the compaction this request admitted (echoed by the
     * compact POST response). The messages endpoint returns entries newest
     * first (measured 2026-10-16), so an older completed compaction must not
     * be mistaken for this request's outcome. Null = the POST response could
     * not be read; recovery then runs through `excludeCompactionIds`.
     */
    expectedCompactionId?: string | null;
    /**
     * Compaction entry ids that already existed BEFORE the POST (the v2
     * analogue of v1's marker snapshot). Used only when
     * `expectedCompactionId` is null: candidates are the entries absent from
     * this list — compactions the POST could have admitted. One candidate is
     * evaluated; several mean ours is among them (pending-progress, keep
     * waiting); none means no visibility yet (stall counting applies).
     */
    excludeCompactionIds?: string[] | null;
    /**
     * Invoked when the matched compaction entry exists but has not reached a
     * terminal outcome (pending/running). The poll loop treats this as
     * progress evidence: visible server work keeps the barrier legitimately
     * held, so the attempt cap counts consecutive rounds WITHOUT such a
     * signal rather than total rounds.
     */
    onMatchedPending?: () => void;
    /** Invoked when snapshot-recovery candidates ALL reached terminal states — ends the poll (see pollCompactionResultV2). */
    onAmbiguousTerminal?: () => void;
    fetchImpl?: FetchLike;
}): Promise<CompactionResult> {
    const unverified: CompactionResult = { status: 'unverified', reason: 'Compaction result could not be verified.' };
    const fetchFn: FetchLike = opts.fetchImpl ?? fetch;
    const url = `${opts.baseUrl}/api/session/${encodeURIComponent(opts.sessionId)}/message`;
    try {
        const response = await fetchFn(url, {
            method: 'GET',
            signal: opts.signal,
            headers: {
                authorization: 'Basic ' + Buffer.from(`opencode:${opts.password}`).toString('base64')
            }
        });
        if (!response.ok) return unverified;
        const payload: unknown = await response.json().catch(() => null);
        const entries = Array.isArray(payload)
            ? payload as OpencodeMessageEntry[]
            : isObjectRecord(payload) && Array.isArray(payload.data)
                ? payload.data as OpencodeMessageEntry[]
                : null;
        if (!entries) return unverified;

        // v2 compaction shape (verified 2026-10-16/18 against opencode
        // v2.0.29, release commit 042d0832f; schema:
        // packages/protocol/openapi.json → Session.Message.Compaction.*):
        // the compaction entry itself carries the outcome inline —
        // `{ type: 'compaction', status: 'running'|'completed'|'failed',
        //   reason: 'auto'|'manual', summary, providerContext }`.
        // OpenCode 2.1 dropped providerContext in favor of a generic `native`
        // record (packages/schema/src/session-message.ts at v2.1.2). There is
        // no assistant message linked via parentID like v1, so the v1 parsing
        // rules do not apply here.
        const compactionEntries = entries.filter((entry) => entry.type === 'compaction');
        let candidates = compactionEntries;
        if (opts.expectedCompactionId) {
            candidates = compactionEntries.filter((entry) => isObjectRecord(entry) && entry.id === opts.expectedCompactionId);
        } else if (opts.excludeCompactionIds) {
            // Identity recovery: only compactions that did not exist before
            // the POST can be ours. An EMPTY snapshot is a valid basis too
            // (fresh session — every entry afterwards is ours).
            const exclude = new Set(opts.excludeCompactionIds);
            candidates = compactionEntries.filter((entry) => !(isObjectRecord(entry) && typeof entry.id === 'string' && exclude.has(entry.id)));
            // Server-initiated auto-compactions (reason !== 'manual') racing
            // between admission and the first poll must never be settled as
            // ours: their summary would end the wait while OUR compaction is
            // still running. When the entries carry a reason field at all,
            // restrict candidates to manual ones; an auto-only pool means no
            // visibility into ours yet (stall counting applies).
            // v2.0.29 always stamps reason (auto|manual — verified against
            // the release schema); entries without one are an unknown shape,
            // so settlement is refused rather than guessed.
            const withReason = candidates.filter((entry) => isObjectRecord(entry) && typeof entry.reason === 'string');
            if (withReason.length > 0) {
                candidates = candidates.filter((entry) => (entry as { reason?: unknown }).reason === 'manual');
            } else {
                candidates = [];
            }
        }
        const latestCompaction = candidates[0] ?? null;
        if (!latestCompaction) return unverified;
        if (candidates.length > 1) {
            // Ambiguous: ours is among the new entries. Pending progress (and
            // thus a stall-counter reset) is only honest while at least one
            // candidate is still non-terminal. Once ALL of them reached a
            // terminal state the outcome can no longer change — signal the
            // poll to END (otherwise sawPending would hold the barrier
            // forever on entries that will never change).
            const anyNonTerminal = candidates.some((entry) => {
                const record = isObjectRecord(entry) ? entry : null;
                const candidateStatus = record && typeof record.status === 'string' ? record.status : undefined;
                // Same whitelist as the single-candidate path: an unrecognized
                // status must not claim pending progress.
                return candidateStatus === 'pending' || candidateStatus === 'running';
            });
            if (anyNonTerminal) {
                opts.onMatchedPending?.();
            } else {
                opts.onAmbiguousTerminal?.();
            }
            return unverified;
        }

        const entryRecord = isObjectRecord(latestCompaction) ? latestCompaction : null;
        const status = entryRecord && typeof entryRecord.status === 'string' ? entryRecord.status : undefined;
        const summary = entryRecord && typeof entryRecord.summary === 'string' ? entryRecord.summary : undefined;

        if (status === 'error' || status === 'failed') {
            const reason = safeErrorReason(latestCompaction.error) ?? 'OpenCode compaction failed.';
            return { status: 'failed', reason };
        }
        if (status === 'completed') {
            if (summary && summary.trim().length > 0) {
                return { status: 'success', text: summary };
            }
            // Native provider compaction (verified 2026-10-18 against the v2
            // binary: `model.compaction?.type === "native"` skips the summary
            // prompt and publishes providerContext instead) legitimately
            // completes with an empty summary — the context checkpoint lives
            // in providerContext. OpenCode 2.1 stores the replacement window in
            // `native.messages` instead and recognizes a native compaction by
            // `native.messages !== undefined` (isNativeCompaction in
            // packages/core/src/session/history.ts at v2.1.2), so accept either
            // shape with the same test.
            const nativeRecord = isObjectRecord(entryRecord?.native) ? entryRecord.native : null;
            if (isObjectRecord(entryRecord?.providerContext) || nativeRecord?.messages !== undefined) {
                return { status: 'success', text: '' };
            }
            return { status: 'failed', reason: 'OpenCode returned an empty compaction summary.' };
        }

        // Matched but not terminal. Progress credit (stall-counter reset) is
        // only honest for KNOWN non-terminal statuses: an unrecognized status
        // string (or a missing one) must not hold the barrier forever — the
        // stall cap then bounds the hold instead.
        if (status === 'pending' || status === 'running') {
            opts.onMatchedPending?.();
        }
        return unverified;
    } catch {
        return unverified;
    }
}
