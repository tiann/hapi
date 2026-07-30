export type OpencodeCompactResult =
    | { ok: true }
    | { ok: false; error: string };

/** Minimal fetch-shaped function signature, kept narrower than `typeof fetch` so tests can pass a plain `vi.fn()` without matching runtime-specific extras (e.g. Bun's `fetch.preconnect`). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

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
 * The response can legitimately take 90s+ to arrive for reasoning models —
 * no client-side timeout/AbortSignal is applied here, mirroring how
 * `AcpSdkBackend.prompt()` uses `timeoutMs: Infinity` for `session/prompt`.
 */
export async function triggerOpencodeCompact(opts: {
    baseUrl: string;
    sessionId: string;
    providerId: string;
    modelId: string;
    fetchImpl?: FetchLike;
}): Promise<OpencodeCompactResult> {
    const fetchFn: FetchLike = opts.fetchImpl ?? fetch;
    const url = `${opts.baseUrl}/session/${encodeURIComponent(opts.sessionId)}/summarize`;

    try {
        const response = await fetchFn(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ providerID: opts.providerId, modelID: opts.modelId })
        });

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
