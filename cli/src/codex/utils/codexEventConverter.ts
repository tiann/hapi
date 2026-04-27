import { randomUUID } from 'node:crypto';
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
            const message = asString(payloadRecord.message);
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
            const itemType = asString(item?.type)?.toLowerCase();
            const message = itemType === 'plan' ? asString(item?.text) : null;
            const turnId = asString(payloadRecord.turn_id);
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
            // Response messages are model conversation state; event_msg carries visible chat.
            return null;
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
