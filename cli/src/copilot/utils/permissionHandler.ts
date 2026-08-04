import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types';
import type { CopilotPermissionMode } from '@hapi/protocol/types';
import { deriveToolName } from '@/agent/utils';
import { logger } from '@/ui/logger';
import {
    BasePermissionHandler,
    type AutoApprovalDecision,
    type PendingPermissionRequest,
    type PermissionCompletion
} from '@/modules/common/permission/BasePermissionHandler';

interface PermissionResponseMessage {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
}

const READ_ONLY_TOOL_NAMES = new Set([
    'read',
    'read file',
    'grep',
    'glob',
    'search',
    'list files'
]);

function deriveToolInput(request: PermissionRequest): unknown {
    if (request.rawInput !== undefined) {
        return request.rawInput;
    }
    return request.rawOutput;
}

function pickOptionId(
    request: PermissionRequest,
    preferredKinds: string[],
    fallbackToFirstOption = true
): string | null {
    for (const kind of preferredKinds) {
        const match = request.options.find((option) => option.kind === kind);
        if (match) {
            return match.optionId;
        }
    }
    return fallbackToFirstOption && request.options.length > 0
        ? request.options[0].optionId
        : null;
}

export function mapCopilotPermissionDecision(
    request: PermissionRequest,
    decision: PermissionResponseMessage['decision']
): PermissionResponse {
    if (decision === 'abort') {
        return { outcome: 'cancelled' };
    }

    if (decision === 'approved_for_session') {
        const optionId = pickOptionId(request, ['allow_always', 'allow_once'], false);
        return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
    }

    if (decision === 'approved') {
        const optionId = pickOptionId(request, ['allow_once', 'allow_always'], false);
        return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
    }

    const optionId = pickOptionId(request, ['reject_once', 'reject_always'], false);
    return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
}

export class CopilotPermissionHandler extends BasePermissionHandler<PermissionResponseMessage, void> {
    private readonly pendingBackendRequests = new Map<string, PermissionRequest>();

    constructor(
        session: ApiSessionClient,
        private readonly backend: AgentBackend,
        private readonly getPermissionMode: () => CopilotPermissionMode | undefined
    ) {
        super(session);
        this.backend.onPermissionRequest((request) => this.handlePermissionRequest(request));
    }

    private handlePermissionRequest(request: PermissionRequest): void {
        const toolName = deriveToolName({
            title: request.title,
            kind: request.kind,
            rawInput: request.rawInput
        });
        const toolInput = deriveToolInput(request);
        const mode = this.getPermissionMode() ?? 'default';

        const autoDecision = mode === 'read-only'
            ? (READ_ONLY_TOOL_NAMES.has(toolName.trim().toLowerCase()) ? 'approved' : null)
            : this.resolveAutoApprovalDecision(mode, toolName, request.toolCallId);
        if (autoDecision) {
            void this.autoApprove(request, toolName, toolInput, autoDecision);
            return;
        }

        this.pendingBackendRequests.set(request.id, request);
        this.addPendingRequest(request.id, toolName, toolInput, {
            resolve: () => {},
            reject: () => {}
        });

        logger.debug(`[Copilot] Permission request queued for ${toolName} (${request.id})`);
    }

    private async autoApprove(
        request: PermissionRequest,
        toolName: string,
        toolInput: unknown,
        decision: AutoApprovalDecision
    ): Promise<void> {
        const outcome = mapCopilotPermissionDecision(request, decision);
        await this.backend.respondToPermission(request.sessionId, request, outcome);

        this.client.updateAgentState((currentState) => ({
            ...currentState,
            completedRequests: {
                ...currentState.completedRequests,
                [request.id]: {
                    tool: toolName,
                    arguments: toolInput,
                    createdAt: Date.now(),
                    completedAt: Date.now(),
                    status: 'approved',
                    decision
                }
            }
        }));

        logger.debug(`[Copilot] Auto-approved ${toolName} (${request.id}) mode=${decision}`);
    }

    protected async handlePermissionResponse(
        response: PermissionResponseMessage,
        pending: PendingPermissionRequest<void>
    ): Promise<PermissionCompletion> {
        const pendingRequest = this.pendingBackendRequests.get(response.id);
        if (pendingRequest) {
            this.pendingBackendRequests.delete(response.id);
        } else {
            logger.debug('[Copilot] Permission response missing backend request', response.id);
        }

        const decision = response.decision ?? (response.approved ? 'approved' : 'denied');

        if (decision === 'abort' && pendingRequest) {
            await this.backend.cancelPrompt(pendingRequest.sessionId);
        }

        if (pendingRequest) {
            const outcome = mapCopilotPermissionDecision(pendingRequest, decision);
            await this.backend.respondToPermission(pendingRequest.sessionId, pendingRequest, outcome);
        }

        pending.resolve();

        logger.debug(`[Copilot] Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);

        return {
            status: response.approved ? 'approved' : 'denied',
            decision,
            reason: response.reason
        };
    }

    protected handleMissingPendingResponse(response: PermissionResponseMessage): void {
        logger.debug('[Copilot] Permission response received for unknown request', response.id);
    }

    async cancelAll(reason: string): Promise<void> {
        const pending = Array.from(this.pendingBackendRequests.values());
        this.pendingBackendRequests.clear();

        for (const request of pending) {
            await this.backend.respondToPermission(request.sessionId, request, { outcome: 'cancelled' });
        }

        this.cancelPendingRequests({
            completedReason: reason,
            rejectMessage: reason,
            decision: 'abort'
        });
    }
}
