import type { AgentBackend } from '@/agent/types';
import type { AgentState } from '@/api/types';

type SessionWithAgentState = {
    getAgentStateSnapshot?: () => AgentState | null;
    updateAgentState: (handler: (state: AgentState) => AgentState) => void;
};

export const STALE_REQUEST_REASON = 'The agent process that asked this has stopped';

/**
 * Settles, as canceled, the stored requests the agent no longer waits for.
 *
 * Permission writers call this when they bind to a backend, which happens on
 * every start of the agent process. A request still pending in stored state
 * then belongs to the previous process: its JSON-RPC call died with it, so an
 * answer could never reach the agent. Leaving it pending would show live
 * approve/deny buttons that do nothing. If the new process asks again, the
 * request gets its own id on the same call card (see allocateRequestId).
 */
export function settleRequestsOfPreviousAgentProcess(backend: AgentBackend, session: SessionWithAgentState): void {
    const hasLiveRequest = backend.hasLiveRequest?.bind(backend);
    if (!hasLiveRequest) return;
    const stored = session.getAgentStateSnapshot?.()?.requests;
    if (!stored || Object.keys(stored).length === 0) return;
    const completedAt = Date.now();
    session.updateAgentState((state) => {
        const requests = state.requests ?? {};
        const remaining: NonNullable<AgentState['requests']> = {};
        const completedRequests = { ...state.completedRequests };
        let changed = false;
        for (const [id, request] of Object.entries(requests)) {
            if (hasLiveRequest(id)) {
                remaining[id] = request;
                continue;
            }
            changed = true;
            completedRequests[id] = {
                ...request,
                completedAt,
                status: 'canceled',
                reason: STALE_REQUEST_REASON,
                decision: 'abort'
            };
        }
        return changed ? { ...state, requests: remaining, completedRequests } : state;
    });
}
