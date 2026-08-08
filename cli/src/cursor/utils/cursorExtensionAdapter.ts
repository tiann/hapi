import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { logger } from '@/ui/logger';
import { asString, isObject } from '@hapi/protocol';
import type { AgentMessage, PlanItem } from '@/agent/types';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
    decodeGeneratedImageBase64,
    detectImageMimeType,
    registerGeneratedImage,
} from '@/modules/common/generatedImages';
import type { InlineMediaSource } from '@/modules/common/inlineMediaSource';

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

/** Invoked when the operator accepts a CreatePlan request (Yes / Yes for session). */
export type CursorCreatePlanAcceptedHandler = () => void;

export class CursorExtensionAdapter {
    private readonly pending = new Map<string, PendingExtensionRequest>();

    constructor(
        private readonly session: ApiSessionClient,
        private readonly backend: AcpSdkBackend,
        private readonly onMessage: CursorExtensionMessageHandler,
        private readonly onCreatePlanAccepted?: CursorCreatePlanAcceptedHandler
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
            await this.handleGenerateImage(params);
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
                pending.respond(wrapOutcome({ outcome: 'cancelled' }));
            } else {
                pending.respond(wrapOutcome({
                    outcome: 'answered',
                    answers: formatQuestionAnswers(pending.arguments, response.answers)
                }));
            }
        } else if (decision === 'abort') {
            pending.respond(wrapOutcome({ outcome: 'cancelled' }));
        } else if (decision === 'denied') {
            pending.respond(wrapOutcome({ outcome: 'rejected' }));
        } else {
            // Accept first so Cursor unblocks, then hand off to execute (mode
            // switch + continue prompt). Without the handoff, Yes ends the turn
            // with "plan done" instead of continuing the user's task.
            pending.respond(wrapOutcome({ outcome: 'accepted' }));
            if (pending.tool === 'CursorCreatePlan') {
                try {
                    this.onCreatePlanAccepted?.();
                } catch (error) {
                    logger.warn('[cursor-acp] onCreatePlanAccepted failed', error);
                }
            }
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

    private async handleGenerateImage(params: unknown): Promise<void> {
        if (!isObject(params)) return;
        const toolCallId = extractToolCallId(params) ?? `cursor-image-${randomUUID()}`;
        const safeParams = summarizeGenerateImageParams(params);
        this.onMessage({
            type: 'tool_call',
            id: toolCallId,
            name: 'CursorGenerateImage',
            input: safeParams,
            status: 'completed'
        });

        const image = await registerCursorGeneratedImage(params);
        if (image) {
            const source: InlineMediaSource = {
                ingress: 'acp',
                flavor: 'cursor',
                toolCallId,
                toolName: 'cursor/generate_image',
            };
            this.onMessage({
                type: 'generated_image',
                imageId: image.id,
                fileName: image.fileName,
                mimeType: image.mimeType,
                source,
            });
        } else {
            const imageData = asString(params.imageData)
                ?? asString(params.image_data)
                ?? asString(params.data);
            logger.debug('[cursor-acp] cursor/generate_image rejected', {
                toolCallId,
                imageDataChars: typeof imageData === 'string' ? imageData.length : 0,
            });
        }

        this.onMessage({
            type: 'tool_result',
            id: toolCallId,
            output: safeParams,
            status: 'completed'
        });
    }

    async cancelAll(reason: string): Promise<void> {
        const entries = Array.from(this.pending.entries());
        this.pending.clear();

        for (const [id, pending] of entries) {
            pending.respond(wrapOutcome({ outcome: 'cancelled' }));

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

/**
 * Cursor's ACP blocking extension methods (`cursor/ask_question`,
 * `cursor/create_plan`) expect the JSON-RPC result to nest the outcome under an
 * `outcome` key, e.g. `{ outcome: { outcome: "accepted" } }`. Returning the
 * outcome object flat (`{ outcome: "accepted" }`) makes Cursor read
 * `response.outcome.outcome` as undefined and fall back to a cancellation, so an
 * approved plan is relayed to the agent as `User cancelled`. See
 * https://cursor.com/docs/cli/acp (CursorCreatePlanResponse / CursorAskQuestionResponse).
 */
function wrapOutcome<T extends { outcome: string }>(outcome: T): { outcome: T } {
    return { outcome };
}

async function registerCursorGeneratedImage(params: Record<string, unknown>) {
    const filePath = asString(params.filePath)
        ?? asString(params.file_path)
        ?? asString(params.path)
        ?? asString(params.imagePath)
        ?? asString(params.image_path);

    const imageData = asString(params.imageData)
        ?? asString(params.image_data)
        ?? asString(params.data);

    // Only inline bytes are safe here. Path-only reads would bypass the
    // permission-gated display_image / display_video / display_media MCP tools (same class as
    // URI-only ACP image blocks). Path support needs an explicit approval flow.
    if (imageData) {
        try {
            const bytes = decodeGeneratedImageBase64(imageData);
            if (!bytes) {
                return null;
            }
            const mimeType = detectImageMimeType(bytes);
            if (!mimeType) {
                return null;
            }
            const path = filePath ?? `${randomUUID()}.bin`;
            return registerGeneratedImage({
                id: randomUUID(),
                path,
                fileName: basename(path),
                mimeType,
                bytes,
            });
        } catch (error) {
            logger.debug('[cursor-acp] failed to register generate_image base64 payload', error);
            return null;
        }
    }

    if (filePath) {
        logger.debug(
            '[cursor-acp] ignoring cursor/generate_image filePath without inline bytes; use display_image/display_video MCP for local paths',
            { filePath },
        );
    }

    return null;
}

/** Drop raw base64 from chat/logs; keep length so rejects stay diagnosable. */
function summarizeGenerateImageParams(params: Record<string, unknown>): Record<string, unknown> {
    const imageData = asString(params.imageData)
        ?? asString(params.image_data)
        ?? asString(params.data);
    const summary: Record<string, unknown> = { ...params };
    delete summary.imageData;
    delete summary.image_data;
    delete summary.data;
    if (typeof imageData === 'string') {
        summary.imageDataChars = imageData.length;
    }
    return summary;
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
