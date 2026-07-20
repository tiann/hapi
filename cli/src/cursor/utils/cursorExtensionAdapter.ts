import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { logger } from '@/ui/logger';
import { asString, isObject } from '@hapi/protocol';
import type { AgentMessage, PlanItem } from '@/agent/types';
import { randomUUID } from 'node:crypto';

type PendingExtensionRequest = {
    tool: string;
    arguments: unknown;
    respond: (result: unknown) => void;
};

type PermissionResponseMessage = {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    answers?: Record<string, string[]>;
};

export type CursorExtensionMessageHandler = (message: AgentMessage) => void;

export class CursorExtensionAdapter {
    private readonly pending = new Map<string, PendingExtensionRequest>();

    constructor(
        private readonly session: ApiSessionClient,
        private readonly backend: AcpSdkBackend,
        private readonly onMessage: CursorExtensionMessageHandler
    ) {
        this.registerHandlers();
    }

    handlePermissionResponse = async (response: PermissionResponseMessage): Promise<boolean> => {
        if (!this.pending.has(response.id)) {
            return false;
        }
        await this.handleResponse(response);
        return true;
    };

    private registerHandlers(): void {
        this.backend.registerExtensionRequestHandler('cursor/ask_question', async (params) => {
            return await this.handleBlockingRequest('CursorAskQuestion', params);
        });

        this.backend.registerExtensionRequestHandler('cursor/create_plan', async (params) => {
            return await this.handleBlockingRequest('CursorCreatePlan', params);
        });

        this.backend.registerExtensionRequestHandler('cursor/update_todos', async (params) => {
            this.handleTodoUpdate(params);
            return {};
        });

        this.backend.registerExtensionRequestHandler('cursor/task', async (params) => {
            this.handleTaskNotification(params);
            return {};
        });

        this.backend.registerExtensionRequestHandler('cursor/generate_image', async (params) => {
            this.handleGenerateImage(params);
            return {};
        });
    }

    private async handleBlockingRequest(tool: string, params: unknown): Promise<unknown> {
        const requestId = extractToolCallId(params) ?? `cursor-${randomUUID()}`;
        const args = isObject(params) ? params : { toolCallId: requestId };

        return await new Promise<unknown>((resolve) => {
            this.pending.set(requestId, {
                tool,
                arguments: args,
                respond: resolve
            });

            this.session.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [requestId]: {
                        tool,
                        arguments: args,
                        createdAt: Date.now()
                    }
                }
            } satisfies AgentState));

            logger.debug(`[cursor-acp] Extension request queued: ${tool} (${requestId})`);
        });
    }

    private async handleResponse(response: PermissionResponseMessage): Promise<void> {
        const pending = this.pending.get(response.id);
        if (!pending) {
            return;
        }

        this.pending.delete(response.id);

        const decision = response.decision ?? (response.approved ? 'approved' : 'denied');
        if (pending.tool === 'CursorAskQuestion') {
            if (decision === 'abort' || decision === 'denied') {
                pending.respond({ outcome: 'cancelled' });
            } else {
                pending.respond({
                    outcome: 'answered',
                    answers: formatQuestionAnswers(pending.arguments, response.answers)
                });
            }
        } else if (decision === 'abort') {
            pending.respond({ outcome: 'cancelled' });
        } else if (decision === 'denied') {
            pending.respond({ outcome: 'rejected' });
        } else {
            pending.respond({ outcome: 'accepted' });
        }

        const status = response.approved ? 'approved' : 'denied';
        this.session.updateAgentState((currentState) => {
            const requestEntry = currentState.requests?.[response.id];
            const { [response.id]: _, ...remaining } = currentState.requests ?? {};
            return {
                ...currentState,
                requests: remaining,
                completedRequests: {
                    ...currentState.completedRequests,
                    [response.id]: {
                        tool: pending.tool,
                        arguments: pending.arguments,
                        createdAt: requestEntry?.createdAt ?? Date.now(),
                        completedAt: Date.now(),
                        status,
                        decision
                    }
                }
            } satisfies AgentState;
        });
    }

    private handleTodoUpdate(params: unknown): void {
        if (!isObject(params)) return;
        const todos = Array.isArray(params.todos) ? params.todos : [];
        const items: PlanItem[] = [];
        for (const entry of todos) {
            if (!isObject(entry)) continue;
            const content = asString(entry.content) ?? asString(entry.title) ?? '';
            if (!content) continue;
            const status = normalizeTodoStatus(asString(entry.status));
            items.push({
                content,
                priority: 'medium',
                status
            });
        }
        if (items.length > 0) {
            this.onMessage({ type: 'plan', items });
        }
    }

    private handleTaskNotification(params: unknown): void {
        if (!isObject(params)) return;
        const toolCallId = extractToolCallId(params) ?? `cursor-task-${randomUUID()}`;
        const title = asString(params.title) ?? asString(params.description) ?? 'Cursor task';
        const status = normalizeTaskStatus(asString(params.status));
        this.onMessage({
            type: 'tool_call',
            id: toolCallId,
            name: 'CursorTask',
            input: { ...params, title },
            status
        });
        if (status === 'completed' || status === 'failed') {
            this.onMessage({
                type: 'tool_result',
                id: toolCallId,
                output: params,
                status
            });
        }
    }

    private handleGenerateImage(params: unknown): void {
        if (!isObject(params)) return;
        const toolCallId = extractToolCallId(params) ?? `cursor-image-${randomUUID()}`;
        this.onMessage({
            type: 'tool_call',
            id: toolCallId,
            name: 'CursorGenerateImage',
            input: params,
            status: 'completed'
        });
        this.onMessage({
            type: 'tool_result',
            id: toolCallId,
            output: params,
            status: 'completed'
        });
    }

    async cancelAll(reason: string): Promise<void> {
        const entries = Array.from(this.pending.entries());
        this.pending.clear();

        for (const [id, pending] of entries) {
            pending.respond(
                pending.tool === 'CursorAskQuestion'
                    ? { outcome: 'cancelled' }
                    : { outcome: 'cancelled' }
            );

            this.session.updateAgentState((currentState) => {
                const requestEntry = currentState.requests?.[id];
                const { [id]: _, ...remaining } = currentState.requests ?? {};
                return {
                    ...currentState,
                    requests: remaining,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [id]: {
                            tool: pending.tool,
                            arguments: pending.arguments,
                            createdAt: requestEntry?.createdAt ?? Date.now(),
                            completedAt: Date.now(),
                            status: 'canceled',
                            reason,
                            decision: 'abort'
                        }
                    }
                } satisfies AgentState;
            });
        }
    }
}

function extractToolCallId(params: unknown): string | null {
    if (!isObject(params)) return null;
    return asString(params.toolCallId);
}

function formatQuestionAnswers(
    params: unknown,
    answers: Record<string, string[]> | undefined
): Array<{ questionId: string; selectedOptionIds: string[] }> {
    if (!answers) return [];
    return Object.entries(answers).map(([questionId, selectedOptionIds]) => ({
        questionId,
        selectedOptionIds
    }));
}

function normalizeTodoStatus(status: string | null): PlanItem['status'] {
    if (status === 'in_progress' || status === 'completed' || status === 'pending') {
        return status;
    }
    return 'pending';
}

function normalizeTaskStatus(status: string | null): 'in_progress' | 'completed' | 'failed' {
    if (!status) {
        // Cursor often emits task notifications without an explicit status when done.
        return 'completed';
    }
    const normalized = status.trim().toLowerCase();
    if (normalized === 'running' || normalized === 'in_progress' || normalized === 'pending' || normalized === 'started') {
        return 'in_progress';
    }
    if (normalized === 'failed' || normalized === 'error' || normalized === 'cancelled' || normalized === 'canceled') {
        return 'failed';
    }
    return 'completed';
}
