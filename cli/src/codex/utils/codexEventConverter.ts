import { randomUUID } from 'node:crypto';
import { INCLUSIVE_INPUT_TOKEN_USAGE_MARKER, type InclusiveInputTokenUsageMarker } from '@hapi/protocol/usage';
import { z } from 'zod';
import { logger } from '@/ui/logger';

const CodexSessionEventSchema = z.object({
    timestamp: z.string().optional(),
    type: z.string(),
    payload: z.unknown().optional()
});

export type CodexSessionEvent = z.infer<typeof CodexSessionEventSchema>;

export type CodexMessage = {
    type: 'message';
    message: string;
    id: string;
} | {
    type: 'proposed_plan';
    plan: string;
    id: string;
    turnId: string;
} | {
    type: 'reasoning';
    message: string;
    id: string;
} | {
    type: 'reasoning-delta';
    delta: string;
} | {
    type: 'token_count';
    info: Record<string, unknown>;
    id: string;
    usageSchema: InclusiveInputTokenUsageMarker['usageSchema'];
    inputTokenSemantics: InclusiveInputTokenUsageMarker['inputTokenSemantics'];
} | {
    type: 'tool-call';
    name: string;
    callId: string;
    input: unknown;
    id: string;
} | {
    type: 'tool-call-result';
    callId: string;
    output: unknown;
    id: string;
    is_error?: boolean;
};

export type CodexEventProjection = {
    sessionId?: string;
    turnId?: string;
    messages?: CodexMessage[];
    userMessage?: string;
    userActivity?: true;
    finishedTurnId?: string;
};

export type CodexConversionAction = {
    type: 'session-found';
    sessionId: string;
} | {
    type: 'user-message';
    message: string;
} | {
    type: 'user-activity';
} | {
    type: 'agent-message';
    message: CodexMessage;
    turnId?: string;
} | {
    type: 'turn-finished';
    turnId: string;
};

export interface CodexEventConverter {
    (rawEvent: unknown): CodexConversionAction[];
    finalize: () => CodexConversionAction[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeItemType(value: unknown): string | null {
    const raw = asString(value);
    return raw ? raw.toLowerCase().replace(/[\s_-]/g, '') : null;
}

function extractTextContent(value: unknown): string {
    if (typeof value === 'string') {
        return value.trim();
    }
    if (!Array.isArray(value)) {
        return '';
    }

    return value
        .map((entry) => {
            if (typeof entry === 'string') {
                return entry;
            }
            const record = asRecord(entry);
            const contentType = normalizeItemType(record?.type);
            if (
                !record
                || (contentType !== null && contentType !== 'text' && contentType !== 'inputtext' && contentType !== 'outputtext')
            ) {
                return '';
            }
            return typeof record.text === 'string' ? record.text : '';
        })
        .join('')
        .trim();
}

function extractVisibleAssistantText(value: unknown): string {
    return extractTextContent(value)
        .replace(/(?:^|\n)<proposed_plan>[\s\S]*?<\/proposed_plan>(?=\n|$)/gi, '\n')
        .trim();
}

function parseArguments(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            logger.debug('[codexEventConverter] Failed to parse tool call input as JSON:', error);
        }
    }

    return value;
}

function extractCallId(payload: Record<string, unknown>): string | null {
    const candidates = [
        'call_id',
        'callId',
        'tool_call_id',
        'toolCallId',
        'id'
    ];

    for (const key of candidates) {
        const value = payload[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }

    return null;
}

function extractResponseItemTurnId(payload: Record<string, unknown>): string | null {
    const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
    return metadata ? asString(metadata.turn_id) ?? asString(metadata.turnId) : null;
}

type AssistantMessageProjection = {
    source: 'semantic' | 'response';
    text: string;
    turnId: string | null;
    itemId: string | null;
};

type PendingResponseFinal = {
    key: string;
    text: string;
    itemId: string | null;
    turnId: string | null;
    messages: CodexMessage[];
};

function extractEventTurnId(event: CodexSessionEvent): string | null {
    const payload = asRecord(event.payload);
    if (!payload) return null;

    return asString(payload.turn_id ?? payload.turnId)
        ?? extractResponseItemTurnId(payload);
}

function extractAssistantMessageProjection(
    event: CodexSessionEvent,
    currentTurnId: string | null
): AssistantMessageProjection | null {
    const payload = asRecord(event.payload);
    if (!payload) return null;

    if (event.type === 'event_msg' && payload.type === 'agent_message') {
        const text = extractVisibleAssistantText(payload.message ?? payload.text ?? payload.content);
        if (!text) return null;
        return {
            source: 'semantic',
            text,
            turnId: extractEventTurnId(event) ?? currentTurnId,
            itemId: asString(payload.id)
        };
    }

    if (event.type === 'event_msg' && payload.type === 'item_completed') {
        const item = asRecord(payload.item);
        if (normalizeItemType(item?.type) !== 'agentmessage') return null;
        const text = extractVisibleAssistantText(item?.content ?? item?.message ?? item?.text);
        if (!text) return null;
        return {
            source: 'semantic',
            text,
            turnId: extractEventTurnId(event) ?? currentTurnId,
            itemId: asString(item?.id)
        };
    }

    if (event.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
        const text = extractVisibleAssistantText(payload.content);
        if (!text) return null;
        return {
            source: 'response',
            text,
            turnId: extractEventTurnId(event) ?? currentTurnId,
            itemId: asString(payload.id)
        };
    }

    return null;
}

function consumeProjection(counts: Map<string, number>, key: string): boolean {
    const count = counts.get(key) ?? 0;
    if (count === 0) return false;
    if (count === 1) counts.delete(key);
    else counts.set(key, count - 1);
    return true;
}

function rememberProjection(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

function isFinalAnswerResponse(event: CodexSessionEvent): boolean {
    const payload = asRecord(event.payload);
    return event.type === 'response_item'
        && payload?.type === 'message'
        && payload.role === 'assistant'
        && normalizeItemType(payload.phase) === 'finalanswer';
}

function findPendingResponseFinalIndex(
    pending: PendingResponseFinal[],
    projection: AssistantMessageProjection,
    key: string
): number {
    if (projection.itemId) {
        const itemIndex = pending.findIndex((entry) => entry.itemId === projection.itemId);
        if (itemIndex !== -1) return itemIndex;
    }
    return pending.findIndex((entry) => entry.key === key);
}

function normalizeCompactionText(value: string): string {
    return value.replace(/\r\n/g, '\n').trim();
}

function checkpointEndsWithSummary(checkpointMessage: string, summaryText: string): boolean {
    if (checkpointMessage === summaryText) return true;
    if (!checkpointMessage.endsWith(summaryText)) return false;

    const prefix = checkpointMessage.slice(0, -summaryText.length);
    return /\n[\t ]*$/.test(prefix);
}

function findCompactionSummaryIndex(
    pending: PendingResponseFinal[],
    payload: Record<string, unknown> | null
): number {
    const rawCheckpointMessage = asString(payload?.message);
    const checkpointMessage = rawCheckpointMessage ? normalizeCompactionText(rawCheckpointMessage) : '';
    if (!checkpointMessage) return -1;

    for (let index = pending.length - 1; index >= 0; index -= 1) {
        const text = normalizeCompactionText(pending[index]?.text ?? '');
        if (text && checkpointEndsWithSummary(checkpointMessage, text)) {
            return index;
        }
    }
    return -1;
}

function convertProjectionToActions(
    projection: CodexEventProjection | null,
    fallbackTurnId: string | null = null
): CodexConversionAction[] {
    if (!projection) return [];

    const actions: CodexConversionAction[] = [];
    if (projection.sessionId) {
        actions.push({ type: 'session-found', sessionId: projection.sessionId });
    }
    if (projection.userMessage) {
        actions.push({ type: 'user-message', message: projection.userMessage });
    } else if (projection.userActivity) {
        actions.push({ type: 'user-activity' });
    }

    const turnId = projection.turnId ?? fallbackTurnId;
    for (const message of projection.messages ?? []) {
        actions.push({
            type: 'agent-message',
            message,
            ...(turnId ? { turnId } : {})
        });
    }
    if (projection.finishedTurnId) {
        actions.push({ type: 'turn-finished', turnId: projection.finishedTurnId });
    }
    return actions;
}

function confirmsPendingFinalVisibility(actions: CodexConversionAction[]): boolean {
    return actions.some((action) => (
        action.type === 'user-message'
        || action.type === 'user-activity'
        || (action.type === 'agent-message' && action.message.type !== 'token_count')
    ));
}

/**
 * Project transcript records into one ordered action stream. Raw final-answer
 * response items are ambiguous: they can be visible fallback messages or
 * internal compaction summaries. Hold them in arrival order until a semantic
 * mirror, subsequent visible activity, compaction checkpoint, or turn boundary
 * resolves them. Later actions must never overtake an older pending final.
 */
export function createCodexEventConverter(): CodexEventConverter {
    let currentTurnId: string | null = null;
    const unmatchedSemanticMessages = new Map<string, number>();
    const unmatchedResponseMessages = new Map<string, number>();
    const pendingResponseFinals: PendingResponseFinal[] = [];

    const emitPendingFinals = (entries: PendingResponseFinal[]): CodexConversionAction[] => {
        const actions: CodexConversionAction[] = [];
        for (const entry of entries) {
            rememberProjection(unmatchedResponseMessages, entry.key);
            for (const message of entry.messages) {
                actions.push({
                    type: 'agent-message',
                    message,
                    ...(entry.turnId ? { turnId: entry.turnId } : {})
                });
            }
        }
        return actions;
    };

    const drainPendingPrefix = (count: number): CodexConversionAction[] => (
        emitPendingFinals(pendingResponseFinals.splice(0, count))
    );

    const drainAllPendingFinals = (): CodexConversionAction[] => (
        drainPendingPrefix(pendingResponseFinals.length)
    );

    const convert = (rawEvent: unknown): CodexConversionAction[] => {
        const parsed = CodexSessionEventSchema.safeParse(rawEvent);
        if (!parsed.success) return [];

        if (parsed.data.type === 'session_meta') {
            currentTurnId = null;
            unmatchedSemanticMessages.clear();
            unmatchedResponseMessages.clear();
            pendingResponseFinals.length = 0;
        }

        currentTurnId = extractEventTurnId(parsed.data) ?? currentTurnId;
        const projection = extractAssistantMessageProjection(parsed.data, currentTurnId);
        const converted = convertCodexEvent(parsed.data);
        const convertedActions = convertProjectionToActions(converted, projection?.turnId ?? null);
        const payload = asRecord(parsed.data.payload);

        if (parsed.data.type === 'compacted') {
            // Local compaction stores its raw assistant summary at the end of
            // checkpoint.message. Remote compaction leaves message empty and
            // stores the summary only in replacement_history, so adjacency is
            // insufficient evidence that the latest pending final is internal.
            const summaryIndex = findCompactionSummaryIndex(pendingResponseFinals, payload);
            if (summaryIndex === -1) return convertedActions;

            const earlierVisibleFinals = drainPendingPrefix(summaryIndex);
            pendingResponseFinals.shift();
            return [...earlierVisibleFinals, ...convertedActions];
        }

        const eventType = parsed.data.type === 'event_msg' ? asString(payload?.type) : null;
        if (eventType === 'task_complete') {
            return [...drainAllPendingFinals(), ...convertedActions];
        }
        if (eventType === 'turn_aborted' || eventType === 'task_failed') {
            pendingResponseFinals.length = 0;
            return convertedActions;
        }

        if (!projection || !converted) {
            return confirmsPendingFinalVisibility(convertedActions)
                ? [...drainAllPendingFinals(), ...convertedActions]
                : convertedActions;
        }

        const key = `${projection.turnId ?? ''}\u0000${projection.text}`;

        const pendingIndex = projection.source === 'semantic'
            ? findPendingResponseFinalIndex(pendingResponseFinals, projection, key)
            : -1;
        if (pendingIndex !== -1) {
            const earlierVisibleFinals = drainPendingPrefix(pendingIndex);
            pendingResponseFinals.shift();
            return [...earlierVisibleFinals, ...convertedActions];
        }

        if (projection.source === 'response' && isFinalAnswerResponse(parsed.data)) {
            if (consumeProjection(unmatchedSemanticMessages, key)) {
                return [];
            }
            // A response-only final answer is ambiguous until the next
            // boundary: task_complete confirms visible output, while compacted
            // identifies an internal context summary. Hold it briefly.
            pendingResponseFinals.push({
                key,
                text: projection.text,
                itemId: projection.itemId,
                turnId: projection.turnId,
                messages: converted.messages ?? []
            });
            return [];
        }

        const opposite = projection.source === 'semantic'
            ? unmatchedResponseMessages
            : unmatchedSemanticMessages;
        if (consumeProjection(opposite, key)) {
            return [];
        }

        const earlierVisibleFinals = drainAllPendingFinals();
        rememberProjection(
            projection.source === 'semantic' ? unmatchedSemanticMessages : unmatchedResponseMessages,
            key
        );
        return [...earlierVisibleFinals, ...convertedActions];
    };

    return Object.assign(convert, {
        finalize: drainAllPendingFinals
    });
}

export function convertCodexEvent(rawEvent: unknown): CodexEventProjection | null {
    const parsed = CodexSessionEventSchema.safeParse(rawEvent);
    if (!parsed.success) {
        return null;
    }

    const { type, payload } = parsed.data;
    const payloadRecord = asRecord(payload);

    if (type === 'session_meta') {
        const sessionId = payloadRecord ? asString(payloadRecord.id) : null;
        if (!sessionId) {
            return null;
        }
        return { sessionId };
    }

    if (!payloadRecord) {
        return null;
    }

    if (type === 'event_msg') {
        const eventType = asString(payloadRecord.type);
        if (!eventType) {
            return null;
        }

        if (eventType === 'user_message') {
            const message = asString(payloadRecord.message)
                ?? asString(payloadRecord.text)
                ?? asString(payloadRecord.content);
            return {
                userActivity: true,
                ...(message ? { userMessage: message } : {})
            };
        }

        if (eventType === 'agent_message') {
            const message = extractVisibleAssistantText(
                payloadRecord.message ?? payloadRecord.text ?? payloadRecord.content
            );
            if (!message) {
                return null;
            }
            return {
                messages: [{
                    type: 'message',
                    message,
                    id: randomUUID()
                }]
            };
        }

        if (eventType === 'item_completed') {
            const item = asRecord(payloadRecord.item);
            const itemType = normalizeItemType(item?.type);
            const turnId = asString(payloadRecord.turn_id ?? payloadRecord.turnId);

            if (itemType === 'usermessage') {
                const message = extractTextContent(item?.content ?? item?.message ?? item?.text);
                return {
                    ...(turnId ? { turnId } : {}),
                    userActivity: true,
                    ...(message ? { userMessage: message } : {})
                };
            }

            if (itemType === 'agentmessage') {
                const message = extractVisibleAssistantText(item?.content ?? item?.message ?? item?.text);
                if (!message) return null;
                return {
                    ...(turnId ? { turnId } : {}),
                    messages: [{
                        type: 'message',
                        message,
                        id: asString(item?.id) ?? randomUUID()
                    }]
                };
            }

            const message = itemType === 'plan' ? asString(item?.text) : null;
            if (!message || message.trim().length === 0 || !turnId) {
                return null;
            }
            return {
                messages: [{
                    type: 'proposed_plan',
                    plan: message,
                    id: asString(item?.id) ?? randomUUID(),
                    turnId
                }]
            };
        }

        if (eventType === 'task_complete' || eventType === 'turn_aborted' || eventType === 'task_failed') {
            const turnId = asString(payloadRecord.turn_id);
            return turnId ? { finishedTurnId: turnId } : null;
        }

        if (eventType === 'agent_reasoning') {
            const message = asString(payloadRecord.text) ?? asString(payloadRecord.message);
            if (!message) {
                return null;
            }
            return {
                messages: [{
                    type: 'reasoning',
                    message,
                    id: randomUUID()
                }]
            };
        }

        if (eventType === 'agent_reasoning_delta') {
            const delta = asString(payloadRecord.delta) ?? asString(payloadRecord.text) ?? asString(payloadRecord.message);
            if (!delta) {
                return null;
            }
            return {
                messages: [{
                    type: 'reasoning-delta',
                    delta
                }]
            };
        }

        if (eventType === 'token_count') {
            const rawInfo = asRecord(payloadRecord.info);
            const info = rawInfo ? { ...rawInfo } : null;
            if (!info) {
                return null;
            }
            if (info.rate_limits === undefined && info.rateLimits === undefined) {
                const rateLimits = payloadRecord.rate_limits ?? payloadRecord.rateLimits;
                if (rateLimits !== undefined) {
                    info.rate_limits = rateLimits;
                }
            }
            return {
                messages: [{
                    type: 'token_count',
                    ...INCLUSIVE_INPUT_TOKEN_USAGE_MARKER,
                    info,
                    id: randomUUID()
                }]
            };
        }

        return null;
    }

    if (type === 'response_item') {
        const itemType = asString(payloadRecord.type);
        if (!itemType) {
            return null;
        }

        if (itemType === 'message') {
            if (payloadRecord.role !== 'assistant') {
                // User/developer response items include injected context. Only
                // semantic user events represent visible chat input.
                return null;
            }
            const message = extractVisibleAssistantText(payloadRecord.content);
            if (!message) {
                return null;
            }
            const turnId = extractResponseItemTurnId(payloadRecord);
            return {
                ...(turnId ? { turnId } : {}),
                messages: [{
                    type: 'message',
                    message,
                    id: asString(payloadRecord.id) ?? randomUUID()
                }]
            };
        }

        if (itemType === 'function_call') {
            const name = asString(payloadRecord.name);
            const callId = extractCallId(payloadRecord);
            if (!name || !callId) {
                return null;
            }
            return {
                messages: [{
                    type: 'tool-call',
                    name,
                    callId,
                    input: parseArguments(payloadRecord.arguments),
                    id: randomUUID()
                }]
            };
        }

        if (itemType === 'function_call_output') {
            const callId = extractCallId(payloadRecord);
            if (!callId) {
                return null;
            }
            return {
                messages: [{
                    type: 'tool-call-result',
                    callId,
                    output: payloadRecord.output,
                    id: randomUUID()
                }]
            };
        }

        if (itemType === 'custom_tool_call') {
            const name = asString(payloadRecord.name);
            const callId = extractCallId(payloadRecord);
            if (!name || !callId) {
                return null;
            }
            const turnId = extractResponseItemTurnId(payloadRecord);
            return {
                ...(turnId ? { turnId } : {}),
                messages: [{
                    type: 'tool-call',
                    name,
                    callId,
                    input: parseArguments(payloadRecord.input),
                    id: randomUUID()
                }]
            };
        }

        if (itemType === 'custom_tool_call_output') {
            const callId = extractCallId(payloadRecord);
            if (!callId) {
                return null;
            }
            const turnId = extractResponseItemTurnId(payloadRecord);
            return {
                ...(turnId ? { turnId } : {}),
                messages: [{
                    type: 'tool-call-result',
                    callId,
                    output: payloadRecord.output,
                    id: randomUUID()
                }]
            };
        }

        if (itemType === 'tool_search_call') {
            const callId = extractCallId(payloadRecord);
            if (!callId) {
                return null;
            }
            return {
                messages: [{
                    type: 'tool-call',
                    name: 'ToolSearch',
                    callId,
                    input: parseArguments(payloadRecord.arguments),
                    id: randomUUID()
                }]
            };
        }

        if (itemType === 'tool_search_output') {
            const callId = extractCallId(payloadRecord);
            if (!callId) {
                return null;
            }
            return {
                messages: [{
                    type: 'tool-call-result',
                    callId,
                    output: {
                        execution: payloadRecord.execution,
                        tools: payloadRecord.tools
                    },
                    id: randomUUID()
                }]
            };
        }

        if (itemType === 'web_search_call') {
            // Transcript web searches have neither a call id nor a separate output item.
            const callId = randomUUID();
            const status = asString(payloadRecord.status)?.toLowerCase();
            const isError = status === 'failed' || status === 'error';
            return {
                messages: [{
                    type: 'tool-call',
                    name: 'WebSearch',
                    callId,
                    input: payloadRecord.action ?? {},
                    id: randomUUID()
                }, {
                    type: 'tool-call-result',
                    callId,
                    output: null,
                    id: randomUUID(),
                    ...(isError ? { is_error: true } : {})
                }]
            };
        }

        return null;
    }

    return null;
}
