import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/rpcTypes';

/** A recovered PID is ownership evidence, not proof of a working Hub connection. */
export async function reconnectRunnerSession(
    options: SpawnSessionOptions,
    result: Extract<SpawnSessionResult, { type: 'success' }>
): Promise<SpawnSessionResult> {
    if (options.agent !== 'codex') return result;
    return await reconnectSharedRunnerSession(result.sessionId)
        ?? { type: 'error', errorMessage: 'The existing Codex process has no verified shared runtime. Stop that session explicitly before reopening it.' };
}

/** Also used before spawning: /new roots share a PID and have no spawn cache. */
export async function reconnectSharedRunnerSession(sessionId: string): Promise<SpawnSessionResult | undefined> {
    try {
        const { findRuntime } = await import('@/codex/shared/registry');
        const runtime = await findRuntime(sessionId, { strict: true });
        if (!runtime) return undefined;
        const { runtimeControl } = await import('@/codex/shared/frontend');
        const reply = await runtimeControl(runtime, 'hapi/reconnectSession', sessionId, { timeoutMs: 10_000 });
        if (typeof reply === 'object' && reply !== null && 'connected' in reply && reply.connected === true) {
            return { type: 'success', sessionId };
        }
        return { type: 'error', errorMessage: 'The existing Codex session could not reconnect to the Hub. Its execution was preserved; retry when the connection is available.' };
    } catch (error) {
        return { type: 'error', errorMessage: `Could not reconnect the existing Codex session; its execution was preserved: ${error instanceof Error ? error.message : String(error)}` };
    }
}
