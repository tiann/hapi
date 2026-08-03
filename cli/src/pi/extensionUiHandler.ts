import { z } from 'zod';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import { createNativeSessionTitleMetadataSync } from '@/agent/nativeSessionTitle';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { logger } from '@/ui/logger';
import type { PiExtensionUiRequest, PiExtensionUiResponse } from './types';

const PiPermissionResponseSchema = z.object({
    id: z.string().min(1),
    approved: z.boolean(),
    decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).optional(),
    reason: z.string().optional(),
    answers: z.record(z.string(), z.union([
        z.array(z.string()),
        z.object({ answers: z.array(z.string()) }),
    ])).optional(),
}).passthrough();

type PiPermissionResponse = z.infer<typeof PiPermissionResponseSchema>;

type PendingExtensionRequest = Extract<PiExtensionUiRequest, {
    method: 'select' | 'confirm' | 'input' | 'editor';
}>;

type PendingEntry = {
    request: PendingExtensionRequest;
    timer: ReturnType<typeof setTimeout> | null;
};

type PiExtensionUiHandlerOptions = {
    session: Pick<ApiSessionClient, 'rpcHandlerManager' | 'updateAgentState' | 'sendAgentMessage' | 'sendSessionEvent' | 'getMetadata' | 'updateMetadata'>;
    sendResponse: (response: PiExtensionUiResponse) => void;
};

// Pi starts its dialog timeout before the event reaches the HAPI process. Keep
// HAPI's cleanup timer ahead of that deadline so a late browser response cannot
// race Pi's own timeout. The 10% allowance covers transport/UI propagation,
// has a 5s ceiling for long-lived dialogs, and is capped at a quarter of a
// short timeout so valid short dialogs still retain at least 75% of their
// requested duration.
const EXTENSION_UI_TIMEOUT_MARGIN_RATIO = 0.1;
const EXTENSION_UI_TIMEOUT_MARGIN_MIN_MS = 100;
const EXTENSION_UI_TIMEOUT_MARGIN_MAX_MS = 5_000;
const EXTENSION_UI_TIMEOUT_MARGIN_MAX_RATIO = 0.25;

export function getExtensionUiCleanupTimeout(timeout: number | undefined): number | undefined {
    if (timeout === undefined || timeout === 0) return undefined;

    const requestedMargin = Math.min(
        EXTENSION_UI_TIMEOUT_MARGIN_MAX_MS,
        Math.max(EXTENSION_UI_TIMEOUT_MARGIN_MIN_MS, Math.ceil(timeout * EXTENSION_UI_TIMEOUT_MARGIN_RATIO)),
    );
    // Even a very short positive timeout must clean up before Pi's timer. Such
    // dialogs are not realistically interactive, so reserve at least 1ms.
    const margin = Math.min(timeout, Math.max(1, Math.min(
        Math.floor(timeout * EXTENSION_UI_TIMEOUT_MARGIN_MAX_RATIO),
        requestedMargin,
    )));
    return timeout - margin;
}

function requestToolName(request: PendingExtensionRequest): string {
    return request.method === 'confirm' ? 'PiExtensionConfirm' : 'request_user_input';
}

function requestArguments(request: PendingExtensionRequest): Record<string, unknown> {
    if (request.method === 'confirm') {
        return { title: request.title, message: request.message };
    }

    const question: Record<string, unknown> = {
        id: request.id,
        header: request.title,
        question: request.title,
        required: true,
        multiple: false,
        options: request.method === 'select'
            ? request.options.map((label) => ({ label, description: null }))
            : [],
    };

    if (request.method === 'input' && request.placeholder) {
        question.placeholder = request.placeholder;
    }
    if (request.method === 'editor') {
        // These fields intentionally travel in the request payload. The web's
        // request_user_input renderer owns their presentation; dropping them here
        // would make an extension editor lose its initial document on the way to
        // the mobile client.
        question.inputType = 'editor';
        if (request.prefill !== undefined) question.prefill = request.prefill;
    }

    return { questions: [question] };
}

function extractAnswer(
    response: PiPermissionResponse,
    request: Exclude<PendingExtensionRequest, { method: 'confirm' }>
): string | null {
    const raw = response.answers?.[request.id];
    const answers = Array.isArray(raw) ? raw : raw?.answers;
    if (!answers || answers.length === 0) return null;

    if (request.method === 'select') {
        for (const answer of answers) {
            const exact = request.options.find((option) => option === answer);
            if (exact !== undefined) return exact;
            const trimmedMatches = request.options.filter((option) => option.trim() === answer);
            if (trimmedMatches.length === 1) return trimmedMatches[0]!;
            if (trimmedMatches.length > 1) return null;
        }
        return null;
    }
    const note = answers.find((answer) => answer.startsWith('user_note: '));
    if (note) return note.slice('user_note: '.length);
    return answers[0] ?? null;
}

function normalizeAnswers(answers: PiPermissionResponse['answers']): Record<string, { answers: string[] }> | undefined {
    if (!answers) return undefined;
    const normalized: Record<string, { answers: string[] }> = {};
    for (const [id, value] of Object.entries(answers)) {
        normalized[id] = { answers: Array.isArray(value) ? value : value.answers };
    }
    return normalized;
}

/**
 * Bridges Pi RPC extension UI events onto HAPI's existing AgentState / Permission
 * RPC contract. Blocking Pi dialogs remain one HAPI request each and are always
 * completed with exactly one extension_ui_response, including timeouts and
 * process shutdown.
 */
export class PiExtensionUiHandler {
    private readonly pending = new Map<string, PendingEntry>();
    private readonly tombstonedIds = new Set<string>();
    private readonly syncTitle: (title: unknown) => void;

    constructor(private readonly options: PiExtensionUiHandlerOptions) {
        this.syncTitle = createNativeSessionTitleMetadataSync(options.session);
        options.session.rpcHandlerManager.registerHandler<unknown, void>(RPC_METHODS.Permission, async (rawResponse) => {
            const parsed = PiPermissionResponseSchema.safeParse(rawResponse);
            if (!parsed.success) {
                logger.debug('[pi] Ignoring malformed extension UI permission response');
                return;
            }
            this.handlePermissionResponse(parsed.data);
        });
    }

    handle(request: PiExtensionUiRequest): void {
        switch (request.method) {
            case 'notify':
                this.options.session.sendSessionEvent({
                    type: 'message',
                    message: `[Pi ${request.notifyType ?? 'info'}] ${request.message}`,
                });
                return;
            case 'setTitle':
                this.syncTitle(request.title);
                return;
            case 'setStatus':
            case 'setWidget':
            case 'set_editor_text':
                logger.debug(`[pi] Extension UI ${request.method} is not exposed by the HAPI transport`);
                return;
            case 'select':
            case 'confirm':
            case 'input':
            case 'editor':
                this.registerPending(request);
                return;
        }
    }

    cancelAll(reason: string, options: { sendResponse?: boolean } = {}): void {
        for (const id of Array.from(this.pending.keys())) {
            this.cancel(id, reason, options.sendResponse ?? true);
        }
    }

    private registerPending(request: PendingExtensionRequest): void {
        if (this.tombstonedIds.has(request.id)) {
            logger.debug(`[pi] Rejecting reused extension request id ${request.id}`);
            this.options.session.sendSessionEvent({ type: 'message', message: `Pi extension request ${request.id} was canceled because its id was already retired.` });
            this.options.sendResponse({ type: 'extension_ui_response', id: request.id, cancelled: true });
            return;
        }
        if (this.pending.has(request.id)) {
            // Pi requires unique ids for a pending RPC dialog. Reusing one could
            // bind a delayed approval to a different dialog, so cancel the old
            // request once and tombstone the id rather than replacing it.
            this.cancel(request.id, 'Duplicate extension UI request id');
            this.tombstonedIds.add(request.id);
            logger.debug(`[pi] Tombstoned duplicate extension request ${request.id}`);
            this.options.session.sendSessionEvent({ type: 'message', message: `Pi extension request ${request.id} was canceled because its id was reused.` });
            return;
        }

        const timeout = request.method === 'editor' ? undefined : getExtensionUiCleanupTimeout(request.timeout);
        // Start this timer before publishing the HAPI request. Pi's deadline
        // began before it emitted the extension_ui_request event.
        const timer = timeout === undefined
            ? null
            : setTimeout(() => this.cancel(request.id, 'Extension UI request timed out'), timeout);
        timer?.unref?.();
        this.pending.set(request.id, { request, timer });

        const tool = requestToolName(request);
        const argumentsValue = requestArguments(request);
        this.options.session.sendAgentMessage({
            type: 'tool-call',
            callId: request.id,
            name: tool,
            input: argumentsValue,
            status: 'in_progress',
        });
        this.options.session.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [request.id]: {
                    tool,
                    arguments: argumentsValue,
                    createdAt: Date.now(),
                },
            },
        } satisfies AgentState));
    }

    private handlePermissionResponse(response: PiPermissionResponse): void {
        const entry = this.pending.get(response.id);
        if (!entry) {
            logger.debug(`[pi] Permission response for unknown extension request ${response.id}`);
            return;
        }

        const { request } = entry;
        if (request.method === 'confirm') {
            this.complete(request.id, response.approved
                ? { type: 'extension_ui_response', id: request.id, confirmed: true }
                : { type: 'extension_ui_response', id: request.id, confirmed: false }, response);
            return;
        }

        const answer = response.approved ? extractAnswer(response, request) : null;
        if (answer === null || (request.method === 'select' && !request.options.includes(answer))) {
            this.complete(request.id, { type: 'extension_ui_response', id: request.id, cancelled: true }, response);
            return;
        }
        this.complete(request.id, { type: 'extension_ui_response', id: request.id, value: answer }, response);
    }

    private cancel(id: string, reason: string, sendResponse = true): void {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.complete(id, { type: 'extension_ui_response', id, cancelled: true }, {
            id,
            approved: false,
            decision: 'abort',
            reason,
        }, sendResponse);
    }

    private complete(id: string, response: PiExtensionUiResponse, permission: PiPermissionResponse, sendResponse = true): void {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        this.tombstonedIds.add(id);
        if (entry.timer) clearTimeout(entry.timer);

        const tool = requestToolName(entry.request);
        const approved = !('cancelled' in response) && (('confirmed' in response && response.confirmed) || 'value' in response);
        // The Hub's deny endpoint normally omits an explicit decision. Match the
        // existing permission adapters: approved=false means a user denial unless
        // this handler itself marked the completion as an abort/cancellation.
        const denied = !approved && permission.decision !== 'abort';
        const answers = normalizeAnswers(permission.answers);
        this.options.session.updateAgentState((currentState) => {
            const request = currentState.requests?.[id];
            const { [id]: _removed, ...remaining } = currentState.requests ?? {};
            return {
                ...currentState,
                requests: remaining,
                completedRequests: {
                    ...currentState.completedRequests,
                    [id]: {
                        tool,
                        arguments: request?.arguments ?? requestArguments(entry.request),
                        createdAt: request?.createdAt ?? Date.now(),
                        completedAt: Date.now(),
                        status: approved ? 'approved' : denied ? 'denied' : 'canceled',
                        reason: permission.reason,
                        decision: permission.decision ?? (approved ? 'approved' : 'denied'),
                        ...(answers ? { answers } : {}),
                    },
                },
            } satisfies AgentState;
        });
        this.options.session.sendAgentMessage({
            type: 'tool-call-result',
            callId: id,
            output: answers ?? response,
            is_error: !approved,
        });
        if (sendResponse) this.options.sendResponse(response);
    }
}
