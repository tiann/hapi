import type { AgentBackend, PermissionRequest, PermissionResponse } from './types';
import type { AgentState } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';
import { deriveToolName } from '@/agent/utils';

interface PermissionResponseMessage {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

function deriveToolInput(request: PermissionRequest): unknown {
    if (request.rawInput !== undefined) {
        return request.rawInput;
    }
    return request.rawOutput;
}

function pickOptionId(request: PermissionRequest, preferredKinds: string[]): string | null {
    for (const kind of preferredKinds) {
        const match = request.options.find((option) => option.kind === kind);
        if (match) return match.optionId;
    }
    return request.options.length > 0 ? request.options[0].optionId : null;
}

export class PermissionAdapter {
    private readonly pendingRequests = new Map<string, PermissionRequest>();

    constructor(
        private readonly session: ApiSessionClient,
        private readonly backend: AgentBackend
    ) {
        this.backend.onPermissionRequest((request) => this.handlePermissionRequest(request));
        this.session.rpcHandlerManager.registerHandler<PermissionResponseMessage, void>(
            'permission',
            async (response) => {
                await this.handlePermissionResponse(response);
            }
        );
    }

    private handlePermissionRequest(request: PermissionRequest): void {
        this.pendingRequests.set(request.id, request);

        const toolName = deriveToolName({
            title: request.title,
            kind: request.kind,
            rawInput: request.rawInput
        });
        const input = deriveToolInput(request);

        this.session.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [request.id]: {
                    tool: toolName,
                    arguments: input,
                    createdAt: Date.now()
                }
            }
        }));

        logger.debug(`[ACP] Permission request queued: ${toolName} (${request.id})`);
    }

    private async handlePermissionResponse(response: PermissionResponseMessage): Promise<void> {
        const pending = this.pendingRequests.get(response.id);
        if (!pending) {
            logger.debug('[ACP] Permission response received for unknown request', response.id);
            return;
        }

        this.pendingRequests.delete(response.id);

        const decision = response.decision ?? (response.approved ? 'approved' : 'denied');
        const toolName = deriveToolName({
            title: pending.title,
            kind: pending.kind,
            rawInput: pending.rawInput
        });
        const toolInput = deriveToolInput(pending);

        const outcome = this.mapDecisionToOutcome(pending, decision);
        if (decision === 'abort') {
            await this.backend.cancelPrompt(pending.sessionId);
            await this.backend.respondToPermission(pending.sessionId, pending, { outcome: 'cancelled' });
            await this.cancelAll('User aborted');
        } else if (outcome) {
            await this.backend.respondToPermission(pending.sessionId, pending, outcome);
        }

        this.session.updateAgentState((currentState) => {
            const requestEntry = currentState.requests?.[response.id];
            const { [response.id]: _, ...remaining } = currentState.requests ?? {};

            const status = response.approved ? 'approved' : 'denied';

            return {
                ...currentState,
                requests: remaining,
                completedRequests: {
                    ...currentState.completedRequests,
                    [response.id]: {
                        tool: toolName,
                        arguments: toolInput,
                        createdAt: requestEntry?.createdAt ?? Date.now(),
                        completedAt: Date.now(),
                        status,
                        decision
                    }
                }
            } satisfies AgentState;
        });

        logger.debug(`[ACP] Permission ${response.approved ? 'approved' : 'denied'} for ${toolName}`);
    }

    private mapDecisionToOutcome(
        request: PermissionRequest,
        decision: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    ): PermissionResponse | null {
        if (decision === 'abort') {
            return { outcome: 'cancelled' };
        }

        if (decision === 'approved_for_session') {
            const optionId = pickOptionId(request, ['allow_always', 'allow_once']);
            return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
        }

        if (decision === 'approved') {
            const optionId = pickOptionId(request, ['allow_once', 'allow_always']);
            return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
        }

        const optionId = pickOptionId(request, ['reject_once', 'reject_always']);
        return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
    }

    async cancelAll(reason: string): Promise<void> {
        const pending = Array.from(this.pendingRequests.values());
        this.pendingRequests.clear();

        for (const request of pending) {
            await this.backend.respondToPermission(request.sessionId, request, { outcome: 'cancelled' });
        }

        this.session.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests ?? {};
            const completedRequests = { ...currentState.completedRequests };

            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason,
                    decision: 'abort'
                };
            }

            return {
                ...currentState,
                requests: {},
                completedRequests
            };
        });
    }
}
