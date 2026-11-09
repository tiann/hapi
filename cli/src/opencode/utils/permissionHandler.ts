import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentBackend, FormElicitationRequest, FormElicitationResponse, PermissionRequest, PermissionResponse } from '@/agent/types';
import { randomUUID } from 'node:crypto';
import { isObject } from '@hapi/protocol';
import type { OpencodePermissionMode } from '@hapi/protocol/types';
import { deriveToolInput, deriveToolName } from '@/agent/utils';
import { logger } from '@/ui/logger';
import {
    buildQuestionContent,
    parseQuestionSchema,
    QUESTION_DISPLAY_TOOL_NAME,
    toAskUserQuestionInput,
    type ElicitedQuestion
} from './opencodeQuestion';
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
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
}

type PendingQuestion = {
    questions: ElicitedQuestion[];
    settle: (response: FormElicitationResponse) => void;
};

function flattenAnswers(answers: PermissionResponseMessage['answers']): Record<string, string[]> {
    const flat: Record<string, string[]> = {};
    if (!isObject(answers)) return flat;
    for (const [key, value] of Object.entries(answers)) {
        if (Array.isArray(value)) {
            flat[key] = value.filter((entry): entry is string => typeof entry === 'string');
        } else if (isObject(value) && Array.isArray(value.answers)) {
            flat[key] = value.answers.filter((entry): entry is string => typeof entry === 'string');
        }
    }
    return flat;
}

function pickOptionId(
    request: PermissionRequest,
    preferredKinds: string[],
    options: { fallbackToFirst?: boolean } = {}
): string | null {
    for (const kind of preferredKinds) {
        const match = request.options.find((option) => option.kind === kind);
        if (match) {
            return match.optionId;
        }
    }
    if (options.fallbackToFirst === false) {
        return null;
    }
    return request.options.length > 0 ? request.options[0].optionId : null;
}

function mapPlanModeDenialToOutcome(request: PermissionRequest): PermissionResponse {
    const optionId = pickOptionId(request, ['reject_once', 'reject_always'], { fallbackToFirst: false });
    return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
}

function mapDecisionToOutcome(request: PermissionRequest, decision: PermissionResponseMessage['decision']): PermissionResponse {
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

export class OpencodePermissionHandler extends BasePermissionHandler<PermissionResponseMessage, void> {
    private readonly pendingBackendRequests = new Map<string, PermissionRequest>();
    private readonly pendingQuestions = new Map<string, PendingQuestion>();
    // Closed by cancelAll (Stop, prompt end, teardown) so a form that reaches
    // us afterwards is declined instead of queued as a card nobody can settle;
    // beginTurn reopens it for the next prompt.
    private acceptingQuestions = true;

    constructor(
        session: ApiSessionClient,
        private readonly backend: AgentBackend,
        private readonly getPermissionMode: () => OpencodePermissionMode | undefined
    ) {
        super(session);
        this.backend.onPermissionRequest((request) => this.handlePermissionRequest(request));
        this.backend.onFormElicitation?.((request) => this.handleFormElicitation(request));
    }

    /**
     * OpenCode's `question` tool asks through a form elicitation, not a tool
     * permission. It is deliberately not routed through
     * `resolveAutoApprovalDecision`: a question has no allow/deny default, so
     * every permission mode (yolo included) waits for the human's answer.
     */
    private handleFormElicitation(request: FormElicitationRequest): Promise<FormElicitationResponse> {
        if (!this.acceptingQuestions) {
            logger.debug('[Opencode] Dismissing form elicitation received outside an active turn');
            return Promise.resolve({ action: 'cancel' });
        }
        const questions = parseQuestionSchema(request.requestedSchema);
        if (!questions) {
            logger.warn('[Opencode] Dismissing form elicitation with an unsupported schema');
            return Promise.resolve({ action: 'cancel' });
        }

        const id = request.toolCallId ?? `opencode-question-${randomUUID()}`;
        // A new form with the same id replaces the old one; the old one can no longer be answered.
        this.pendingQuestions.get(id)?.settle({ action: 'cancel' });

        return new Promise<FormElicitationResponse>((resolve) => {
            const settle = (response: FormElicitationResponse) => {
                if (this.pendingQuestions.get(id)?.settle === settle) {
                    this.pendingQuestions.delete(id);
                }
                resolve(response);
            };
            this.pendingQuestions.set(id, { questions, settle });
            this.addPendingRequest(id, QUESTION_DISPLAY_TOOL_NAME, toAskUserQuestionInput(questions), {
                resolve: () => {},
                reject: () => settle({ action: 'cancel' })
            });
            logger.debug(`[Opencode] Question form queued (${id})`);
        });
    }

    private completeQuestion(
        question: PendingQuestion,
        response: PermissionResponseMessage
    ): PermissionCompletion {
        const decision = response.decision ?? (response.approved ? 'approved' : 'denied');
        if (decision === 'denied' || decision === 'abort') {
            question.settle({ action: 'cancel' });
            return { status: 'denied', decision, reason: response.reason };
        }

        const answers = flattenAnswers(response.answers);
        const content = buildQuestionContent(question.questions, answers);
        if (!content) {
            question.settle({ action: 'cancel' });
            return { status: 'denied', decision: 'denied', reason: 'No answers were provided.' };
        }

        question.settle({ action: 'accept', content });
        return { status: 'approved', decision, answers };
    }

    private handlePermissionRequest(request: PermissionRequest): void {
        const toolName = deriveToolName({
            title: request.title,
            kind: request.kind,
            rawInput: request.rawInput
        });
        const toolInput = deriveToolInput(request);
        const mode = this.getPermissionMode() ?? 'default';

        const autoDecision = this.resolveAutoApprovalDecision(mode, toolName, request.toolCallId);
        if (autoDecision) {
            void this.autoApprove(request, toolName, toolInput, autoDecision);
            return;
        }

        if (mode === 'plan') {
            void this.denyForPlanMode(request, toolName, toolInput);
            return;
        }

        this.pendingBackendRequests.set(request.id, request);
        this.addPendingRequest(request.id, toolName, toolInput, {
            resolve: () => {},
            reject: () => {}
        });

        logger.debug(`[Opencode] Permission request queued for ${toolName} (${request.id})`);
    }

    private async autoApprove(
        request: PermissionRequest,
        toolName: string,
        toolInput: unknown,
        decision: AutoApprovalDecision
    ): Promise<void> {
        const outcome = mapDecisionToOutcome(request, decision);
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

        logger.debug(`[Opencode] Auto-approved ${toolName} (${request.id}) mode=${decision}`);
    }

    private async denyForPlanMode(
        request: PermissionRequest,
        toolName: string,
        toolInput: unknown
    ): Promise<void> {
        const outcome = mapPlanModeDenialToOutcome(request);
        await this.backend.respondToPermission(request.sessionId, request, outcome);

        const timestamp = Date.now();
        const status = outcome.outcome === 'selected' ? 'denied' : 'canceled';
        this.client.updateAgentState((currentState) => ({
            ...currentState,
            completedRequests: {
                ...currentState.completedRequests,
                [request.id]: {
                    tool: toolName,
                    arguments: toolInput,
                    createdAt: timestamp,
                    completedAt: timestamp,
                    status,
                    reason: 'Plan mode blocks tool execution',
                    decision: status === 'denied' ? 'denied' : 'abort'
                }
            }
        }));

        logger.debug(`[Opencode] Denied ${toolName} (${request.id}) in plan mode`);
    }

    protected async handlePermissionResponse(
        response: PermissionResponseMessage,
        pending: PendingPermissionRequest<void>
    ): Promise<PermissionCompletion> {
        const question = this.pendingQuestions.get(response.id);
        if (question) {
            this.pendingQuestions.delete(response.id);
            return this.completeQuestion(question, response);
        }

        const pendingRequest = this.pendingBackendRequests.get(response.id);
        if (pendingRequest) {
            this.pendingBackendRequests.delete(response.id);
        } else {
            logger.debug('[Opencode] Permission response missing backend request', response.id);
        }

        const decision = response.decision ?? (response.approved ? 'approved' : 'denied');

        if (decision === 'abort' && pendingRequest) {
            await this.backend.cancelPrompt(pendingRequest.sessionId);
        }

        if (pendingRequest) {
            const outcome = mapDecisionToOutcome(pendingRequest, decision);
            await this.backend.respondToPermission(pendingRequest.sessionId, pendingRequest, outcome);
        }

        pending.resolve();

        logger.debug(`[Opencode] Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);

        return {
            status: response.approved ? 'approved' : 'denied',
            decision,
            reason: response.reason
        };
    }

    protected handleMissingPendingResponse(response: PermissionResponseMessage): void {
        logger.debug('[Opencode] Permission response received for unknown request', response.id);
    }

    /** Start accepting questions again; call when a new prompt begins. */
    beginTurn(): void {
        this.acceptingQuestions = true;
    }

    async cancelAll(reason: string): Promise<void> {
        // Close synchronously, before any await, so a form delivered while the
        // cleanup below is still running is already declined.
        this.acceptingQuestions = false;
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
