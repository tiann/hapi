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

export type CodexConversionResult = {
    sessionId?: string;
    turnId?: string;
    messages?: CodexMessage[];
    userMessage?: string;
    userActivity?: true;
    finishedTurnId?: string;
};

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
            turnId: extractEventTurnId(event) ?? currentTurnId
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
            turnId: extractEventTurnId(event) ?? currentTurnId
        };
    }

    if (event.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
        const text = extractVisibleAssistantText(payload.content);
        if (!text) return null;
        return {
            source: 'response',
            text,
            turnId: extractEventTurnId(event) ?? currentTurnId
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

/**
 * Transcript chat text is duplicated across Codex's semantic events and raw
 * response items. Keep both as compatible sources, but project each visible
 * assistant message once. Some Codex versions only persist final answers as
 * response_item messages, while 0.147+ replaced legacy agent_message events
 * with item_completed AgentMessage records.
 */
export function createCodexEventConverter(): (rawEvent: unknown) => CodexConversionResult | null {
    let currentTurnId: string | null = null;
    const unmatchedSemanticMessages = new Map<string, number>();
    const unmatchedResponseMessages = new Map<string, number>();

    return (rawEvent: unknown): CodexConversionResult | null => {
        const parsed = CodexSessionEventSchema.safeParse(rawEvent);
        if (!parsed.success) return null;

        if (parsed.data.type === 'session_meta') {
            currentTurnId = null;
            unmatchedSemanticMessages.clear();
            unmatchedResponseMessages.clear();
        }

        currentTurnId = extractEventTurnId(parsed.data) ?? currentTurnId;
        const projection = extractAssistantMessageProjection(parsed.data, currentTurnId);
        const converted = convertCodexEvent(parsed.data);
        if (!projection || !converted) return converted;

        const key = `${projection.turnId ?? ''}\u0000${projection.text}`;
        const opposite = projection.source === 'semantic'
            ? unmatchedResponseMessages
            : unmatchedSemanticMessages;
        if (consumeProjection(opposite, key)) {
            return null;
        }

        rememberProjection(
            projection.source === 'semantic' ? unmatchedSemanticMessages : unmatchedResponseMessages,
            key
        );
        return converted;
    };
}

export function convertCodexEvent(rawEvent: unknown): CodexConversionResult | null {
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
