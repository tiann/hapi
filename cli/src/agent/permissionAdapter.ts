import type { AgentBackend, PermissionRequest, PermissionResponse } from './types';
import type { AgentState, SessionPermissionMode } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';
import { deriveToolInput, deriveToolName } from '@/agent/utils';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { settleRequestsOfPreviousAgentProcess } from '@/modules/common/permission/settleStaleRequests';
import {
    resolveToolAutoApprovalDecision,
    type AutoApprovalDecision
} from '@/modules/common/permission/BasePermissionHandler';

interface PermissionResponseMessage {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

function permissionOption(request: PermissionRequest, kind: string) {
    return request.options.find((option) => option.kind === kind);
}

export class PermissionAdapter {
    private readonly pendingRequests = new Map<string, PermissionRequest>();

    constructor(
        private readonly session: ApiSessionClient,
        private readonly backend: AgentBackend,
        private readonly getPermissionMode?: () => SessionPermissionMode | undefined,
        private readonly interceptPermissionResponse?: (response: PermissionResponseMessage) => Promise<boolean>
    ) {
        settleRequestsOfPreviousAgentProcess(this.backend, this.session);
        this.backend.onPermissionRequest((request) => this.handlePermissionRequest(request));
        this.session.rpcHandlerManager.registerHandler<PermissionResponseMessage, void>(
            RPC_METHODS.Permission,
            async (response) => {
                if (this.interceptPermissionResponse) {
                    const handled = await this.interceptPermissionResponse(response);
                    if (handled) {
                        return;
                    }
                }
                await this.handlePermissionResponse(response);
            }
        );
    }

    private handlePermissionRequest(request: PermissionRequest): void {
        const toolName = deriveToolName({
            title: request.title,
            kind: request.kind,
            rawInput: request.rawInput
        });
        const input = deriveToolInput(request);
        const mode = this.getPermissionMode?.();
        const autoDecision = resolveToolAutoApprovalDecision(
            mode,
            toolName,
            request.toolCallId
        );

        const once = permissionOption(request, 'allow_once');
        const always = permissionOption(request, 'allow_always');
        const autoOption = autoDecision === 'approved_for_session' ? always ?? once : once;
        if (autoDecision && autoOption) {
            void this.autoApproveRequest(request, toolName, input, autoOption.kind === 'allow_always' ? 'approved_for_session' : 'approved', autoOption.optionId);
            return;
        }

        this.pendingRequests.set(request.id, request);

        this.session.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [request.id]: {
                    tool: toolName,
                    toolCallId: request.toolCallId,
                    arguments: input,
                    acpAllowOptions: {
                        ...(once && { allow_once: once.name }),
                        ...(always && { allow_always: always.name })
                    },
                    createdAt: Date.now()
                }
            }
        }));

        logger.debug(`[ACP] Permission request queued: ${toolName} (${request.id})`);
    }

    private async autoApproveRequest(
        request: PermissionRequest,
        toolName: string,
        input: unknown,
        decision: AutoApprovalDecision,
        optionId: string
    ): Promise<void> {
        const outcome: PermissionResponse = { outcome: 'selected', optionId };
        await this.backend.respondToPermission(request.sessionId, request, outcome);

        const timestamp = Date.now();

        this.session.updateAgentState((currentState) => ({
            ...currentState,
            completedRequests: {
                ...currentState.completedRequests,
                [request.id]: {
                    tool: toolName,
                    toolCallId: request.toolCallId,
                    arguments: input,
                    createdAt: timestamp,
                    completedAt: timestamp,
                    status: 'approved',
                    decision
                }
            }
        } satisfies AgentState));

        logger.debug(
            `[ACP] Auto-approved ` +
            `${toolName} (${request.id}) with decision=${decision}`
        );
    }

    private async handlePermissionResponse(response: PermissionResponseMessage): Promise<void> {
        const pending = this.pendingRequests.get(response.id);
        if (!pending) {
            logger.debug('[ACP] Permission response received for unknown request', response.id);
            return;
        }

        const decision = response.decision ?? (response.approved ? 'approved' : 'denied');
        if (response.approved !== (decision === 'approved' || decision === 'approved_for_session')) {
            throw new Error('Permission response conflicts with its requested decision');
        }
        const toolName = deriveToolName({
            title: pending.title,
            kind: pending.kind,
            rawInput: pending.rawInput
        });
        const toolInput = deriveToolInput(pending);

        // Never substitute a grant with a different lifetime or rely on the order of options.
        const kind = decision === 'approved' ? 'allow_once'
            : decision === 'approved_for_session' ? 'allow_always' : 'reject_once';
        const option = permissionOption(pending, kind);
        if ((decision === 'approved' || decision === 'approved_for_session') && !option) {
            throw new Error(`Agent does not offer ${kind} for this request`);
        }
        const outcome: PermissionResponse = option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
        this.pendingRequests.delete(response.id);
        if (decision === 'abort') {
            await this.backend.cancelPrompt(pending.sessionId);
            await this.backend.respondToPermission(pending.sessionId, pending, { outcome: 'cancelled' });
            await this.cancelAll('User aborted');
        } else {
            await this.backend.respondToPermission(pending.sessionId, pending, outcome);
        }

        this.session.updateAgentState((currentState) => {
            const requestEntry = currentState.requests?.[response.id];
            const { [response.id]: _, ...remaining } = currentState.requests ?? {};

            const status = decision === 'abort' ? 'canceled' : decision === 'denied' ? 'denied' : 'approved';

            return {
                ...currentState,
                requests: remaining,
                completedRequests: {
                    ...currentState.completedRequests,
                    [response.id]: {
                        tool: toolName,
                        toolCallId: pending.toolCallId,
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
