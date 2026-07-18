import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionRequest, PermissionResponse } from '@/agent/types';
import { deriveToolName } from '@/agent/utils';
import type { GrokPermissionMode } from '@hapi/protocol/types';
import {
    BasePermissionHandler,
    type AutoApprovalDecision,
    type PendingPermissionRequest,
    type PermissionCompletion
} from '@/modules/common/permission/BasePermissionHandler';
import type {
    GrokAcpBackend,
    GrokAskUserQuestionRequest,
    GrokAskUserQuestionResponse,
    GrokPlanApprovalRequest,
    GrokPlanApprovalResponse
} from './grokBackend';
import { GrokCancelTimeoutError } from './grokBackend';

type GrokWebResponse = {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
};

type PendingKind =
    | { type: 'permission'; request: PermissionRequest }
    | { type: 'question'; request: GrokAskUserQuestionRequest }
    | { type: 'plan'; request: GrokPlanApprovalRequest };

type NativeResponse = PermissionResponse | GrokAskUserQuestionResponse | GrokPlanApprovalResponse;

function pickOption(request: PermissionRequest, kinds: string[]): string | null {
    for (const kind of kinds) {
        const found = request.options.find((option) => option.kind === kind);
        if (found) return found.optionId;
    }
    return null;
}

function permissionOutcome(request: PermissionRequest, decision: GrokWebResponse['decision']): PermissionResponse {
    if (decision === 'abort') return { outcome: 'cancelled' };
    const kinds = decision === 'approved_for_session'
        ? ['allow_always', 'allow_once']
        : decision === 'approved'
            ? ['allow_once', 'allow_always']
            : ['reject_once', 'reject_always'];
    const optionId = pickOption(request, kinds);
    return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
}

function flatAnswers(answers: GrokWebResponse['answers']): Record<string, string[]> {
    if (!answers) return {};
    return Object.fromEntries(Object.entries(answers).map(([key, value]) => [
        key,
        Array.isArray(value) ? value : value.answers
    ]));
}

export class GrokPermissionHandler extends BasePermissionHandler<GrokWebResponse, NativeResponse> {
    private readonly kinds = new Map<string, PendingKind>();

    constructor(
        session: ApiSessionClient,
        private readonly backend: GrokAcpBackend,
        private readonly getPermissionMode: () => GrokPermissionMode | undefined
    ) {
        super(session);
        backend.onPermissionRequest((request) => this.handlePermission(request));
        backend.onAskUserQuestion((request) => this.handleQuestion(request));
        backend.onPlanApproval((request) => this.handlePlan(request));
    }

    private handlePermission(request: PermissionRequest): void {
        const toolName = deriveToolName({ title: request.title, kind: request.kind, rawInput: request.rawInput });
        const input = request.rawInput ?? request.rawOutput;
        const auto = this.resolveAutoApprovalDecision(this.getPermissionMode() ?? 'default', toolName, request.toolCallId);
        if (auto) {
            void this.autoApprove(request, toolName, input, auto);
            return;
        }
        this.kinds.set(request.id, { type: 'permission', request });
        this.addPendingRequest(request.id, toolName, input, { resolve: () => {}, reject: () => {} });
    }

    private async autoApprove(request: PermissionRequest, tool: string, input: unknown, decision: AutoApprovalDecision): Promise<void> {
        const outcome = permissionOutcome(request, decision);
        await this.backend.respondToPermission(request.sessionId, request, outcome);
        this.client.updateAgentState((state) => ({
            ...state,
            completedRequests: {
                ...state.completedRequests,
                [request.id]: {
                    tool,
                    arguments: input,
                    createdAt: Date.now(),
                    completedAt: Date.now(),
                    status: outcome.outcome === 'selected' ? 'approved' : 'canceled',
                    decision: outcome.outcome === 'selected' ? decision : 'abort'
                }
            }
        }));
    }

    private handleQuestion(request: GrokAskUserQuestionRequest): Promise<GrokAskUserQuestionResponse> {
        this.kinds.set(request.toolCallId, { type: 'question', request });
        return new Promise((resolve, reject) => {
            this.addPendingRequest(request.toolCallId, 'ask_user_question', { questions: request.questions }, {
                resolve: (value) => resolve(value as GrokAskUserQuestionResponse), reject
            });
        });
    }

    private handlePlan(request: GrokPlanApprovalRequest): Promise<GrokPlanApprovalResponse> {
        this.kinds.set(request.toolCallId, { type: 'plan', request });
        return new Promise((resolve, reject) => {
            this.addPendingRequest(request.toolCallId, 'exit_plan_mode', { plan: request.planContent }, {
                resolve: (value) => resolve(value as GrokPlanApprovalResponse), reject
            });
        });
    }

    protected async handlePermissionResponse(
        response: GrokWebResponse,
        pending: PendingPermissionRequest<NativeResponse>
    ): Promise<PermissionCompletion> {
        const kind = this.kinds.get(response.id);
        this.kinds.delete(response.id);
        const decision = response.decision ?? (response.approved ? 'approved' : 'denied');
        let completionStatus: PermissionCompletion['status'] = decision === 'abort'
            ? 'canceled'
            : response.approved
                ? 'approved'
                : 'denied';
        if (!kind) {
            pending.resolve({ outcome: 'abandoned' });
            return { status: 'canceled', decision: 'abort' };
        }
        if (kind.type === 'permission') {
            if (decision === 'abort') {
                try {
                    await this.backend.cancelPrompt(kind.request.sessionId);
                } catch (error) {
                    if (!(error instanceof GrokCancelTimeoutError)) throw error;
                }
            }
            const outcome = permissionOutcome(kind.request, decision);
            await this.backend.respondToPermission(kind.request.sessionId, kind.request, outcome);
            pending.resolve(outcome);
            if (outcome.outcome === 'cancelled') completionStatus = 'canceled';
        } else if (kind.type === 'question') {
            if (decision === 'abort') {
                pending.resolve({ outcome: 'skip_interview' });
            } else {
                const incoming = flatAnswers(response.answers);
                const mapped: Record<string, string[]> = {};
                kind.request.questions.forEach((question, index) => {
                    const answer = incoming[question.question] ?? incoming[String(index)];
                    if (answer) mapped[question.question] = answer;
                });
                pending.resolve(response.approved
                    ? { outcome: 'accepted', answers: mapped }
                    : { outcome: 'chat_about_this', partial_answers: mapped });
            }
        } else {
            pending.resolve(response.approved
                ? { outcome: 'approved' }
                : decision === 'abort'
                    ? { outcome: 'abandoned' }
                    : { outcome: 'request_changes', ...(response.reason ? { feedback: response.reason } : {}) });
        }
        return {
            status: completionStatus,
            decision,
            reason: response.reason,
            answers: response.answers
        };
    }

    protected handleMissingPendingResponse(): void {}

    async cancelAll(reason: string): Promise<void> {
        for (const [id, kind] of this.kinds) {
            const pending = this.pendingRequests.get(id);
            if (!pending) continue;
            if (kind.type === 'permission') {
                await this.backend.respondToPermission(kind.request.sessionId, kind.request, { outcome: 'cancelled' });
                pending.resolve({ outcome: 'cancelled' });
            } else if (kind.type === 'question') {
                pending.resolve({ outcome: 'skip_interview' });
            } else {
                pending.resolve({ outcome: 'abandoned' });
            }
        }
        this.kinds.clear();
        this.cancelPendingRequests({ completedReason: reason, rejectMessage: reason, decision: 'abort' });
    }
}
