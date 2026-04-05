/**
 * Permission Handler for Codex tool approval integration
 * 
 * Handles tool permission requests and responses for Codex sessions.
 * Simpler than Claude's permission handler since we get tool IDs directly.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import type { CodexPermissionMode } from "@hapi/protocol/types";
import {
    BasePermissionHandler,
    type AutoApprovalDecision,
    type PendingPermissionRequest,
    type PermissionCompletion
} from "@/modules/common/permission/BasePermissionHandler";

interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
}

type ToolPermissionResult = {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
};

type UserInputResult = {
    answers: Record<string, string[]> | Record<string, { answers: string[] }>;
};

type PermissionResult = ToolPermissionResult | UserInputResult;

type CodexPermissionHandlerOptions = {
    onRequest?: (request: { id: string; toolName: string; input: unknown }) => void;
    onComplete?: (result: {
        id: string;
        toolName: string;
        input: unknown;
        approved: boolean;
        decision?: ToolPermissionResult['decision'];
        reason?: string;
        answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
    }) => void;
};

export class CodexPermissionHandler extends BasePermissionHandler<PermissionResponse, PermissionResult> {
    constructor(
        session: ApiSessionClient,
        private readonly getPermissionMode: () => CodexPermissionMode | undefined,
        private readonly options?: CodexPermissionHandlerOptions
    ) {
        super(session);
    }

    protected override onRequestRegistered(id: string, toolName: string, input: unknown): void {
        this.options?.onRequest?.({ id, toolName, input });
    }

    private completeAutoApproval(
        id: string,
        toolName: string,
        input: unknown,
        decision: AutoApprovalDecision
    ): ToolPermissionResult {
        const timestamp = Date.now();

        this.options?.onRequest?.({ id, toolName, input });
        this.options?.onComplete?.({
            id,
            toolName,
            input,
            approved: true,
            decision
        });

        this.client.updateAgentState((currentState) => ({
            ...currentState,
            completedRequests: {
                ...currentState.completedRequests,
                [id]: {
                    tool: toolName,
                    arguments: input,
                    createdAt: timestamp,
                    completedAt: timestamp,
                    status: 'approved',
                    decision
                }
            }
        }));

        logger.debug(`[Codex] Auto-approved ${toolName} (${id}) with decision=${decision}`);

        return { decision };
    }

    /**
     * Handle a tool permission request
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown
    ): Promise<ToolPermissionResult> {
        const mode = this.getPermissionMode() ?? 'default';
        const autoDecision = this.resolveAutoApprovalDecision(mode, toolName, toolCallId);
        if (autoDecision) {
            return Promise.resolve(this.completeAutoApproval(toolCallId, toolName, input, autoDecision));
        }

        return new Promise<PermissionResult>((resolve, reject) => {
            // Store the pending request
            this.addPendingRequest(toolCallId, toolName, input, { resolve, reject });

            // Send push notification
            // this.session.api.push().sendToAllDevices(
            //     'Permission Request',
            //     `Codex wants to use ${toolName}`,
            //     {
            //         sessionId: this.session.sessionId,
            //         requestId: toolCallId,
            //         tool: toolName,
            //         type: 'permission_request'
            //     }
            // );

            logger.debug(`[Codex] Permission request sent for tool: ${toolName} (${toolCallId})`);
        }).then((result) => {
            if ('answers' in result) {
                throw new Error(`Expected permission decision for ${toolName}, received request_user_input answers`);
            }
            return result;
        });
    }

    async handleUserInputRequest(
        toolCallId: string,
        input: unknown
    ): Promise<Record<string, string[]> | Record<string, { answers: string[] }>> {
        return new Promise<PermissionResult>((resolve, reject) => {
            this.addPendingRequest(toolCallId, 'request_user_input', input, { resolve, reject });
            logger.debug(`[Codex] User-input request sent (${toolCallId})`);
        }).then((result) => {
            if (!('answers' in result)) {
                throw new Error(`Expected request_user_input answers for ${toolCallId}, received permission decision`);
            }
            return result.answers;
        });
    }

    /**
     * Handle permission responses
     */
    protected async handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingPermissionRequest<PermissionResult>
    ): Promise<PermissionCompletion> {
        if (pending.toolName === 'request_user_input') {
            const answers = response.answers ?? {};

            if (!response.approved || Object.keys(answers).length === 0) {
                pending.reject(new Error(response.reason || 'No answers were provided.'));
                logger.debug('[Codex] User-input request denied or missing answers');
                return {
                    status: response.approved ? 'denied' : 'canceled',
                    reason: response.reason || 'No answers were provided.',
                    decision: response.decision ?? (response.approved ? 'denied' : 'abort'),
                    answers
                };
            }

            pending.resolve({ answers });
            logger.debug('[Codex] User-input request approved');

            this.options?.onComplete?.({
                id: response.id,
                toolName: pending.toolName,
                input: pending.input,
                approved: true,
                answers
            });

            return {
                status: 'approved',
                answers
            };
        }

        const reason = typeof response.reason === 'string' ? response.reason : undefined;
        const result: ToolPermissionResult = response.approved
            ? {
                decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved',
                reason
            }
            : {
                decision: response.decision === 'denied' ? 'denied' : 'abort',
                reason
            };

        pending.resolve(result);
        logger.debug(`[Codex] Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);

        this.options?.onComplete?.({
            id: response.id,
            toolName: pending.toolName,
            input: pending.input,
            approved: response.approved,
            decision: result.decision,
            reason: result.reason,
            answers: response.answers
        });

        return {
            status: response.approved ? 'approved' : 'denied',
            decision: result.decision,
            reason: result.reason
        };
    }

    protected handleMissingPendingResponse(_response: PermissionResponse): void {
        logger.debug('[Codex] Permission request not found or already resolved');
    }

    /**
     * Reset state for new sessions
     */
    reset(): void {
        this.cancelPendingRequests({
            completedReason: 'Session reset',
            rejectMessage: 'Session reset'
        });

        logger.debug('[Codex] Permission handler reset');
    }
}
