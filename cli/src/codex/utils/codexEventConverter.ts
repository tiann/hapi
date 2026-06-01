import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@/ui/logger';
import { AppServerEventConverter, type ConvertedEvent } from './appServerEventConverter';

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
    type: 'thread_goal_updated';
    thread_id: string;
    turn_id?: string;
    goal: Record<string, unknown>;
} | {
    type: 'thread_goal_cleared';
    thread_id: string;
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
};

export type CodexConversionResult = {
    sessionId?: string;
    message?: CodexMessage | ConvertedEvent;
    userMessage?: string;
};

export class CodexTranscriptEventConverter {
    private readonly appServerEventConverter = new AppServerEventConverter();

    convert(rawEvent: unknown): CodexConversionResult[] {
        const direct = convertCodexEvent(rawEvent);
        if (direct) {
            return [direct];
        }

        const appServerEvents = this.convertAppServerEvent(rawEvent);
        return appServerEvents.map((message) => ({ message }));
    }

    reset(): void {
        this.appServerEventConverter.reset();
    }

    private convertAppServerEvent(rawEvent: unknown): ConvertedEvent[] {
        const parsed = CodexSessionEventSchema.safeParse(rawEvent);
        if (!parsed.success) {
            return [];
        }

        const payloadRecord = asRecord(parsed.data.payload);

        if (parsed.data.type === 'notification' || parsed.data.type === 'app_server_notification') {
            const method = asString(payloadRecord?.method);
            if (!method) {
                return [];
            }
            return this.appServerEventConverter.handleNotification(method, payloadRecord?.params);
        }

        if (parsed.data.type.startsWith('codex/event/')) {
            const msgType = parsed.data.type.slice('codex/event/'.length);
            return this.appServerEventConverter.handleNotification(parsed.data.type, {
                msg: payloadRecord?.type ? payloadRecord : {
                    ...(payloadRecord ?? {}),
                    type: msgType
                }
            });
        }

        if (parsed.data.type.includes('/')) {
            return this.appServerEventConverter.handleNotification(parsed.data.type, payloadRecord ?? {});
        }

        return [];
    }
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

function parseArguments(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            logger.debug('[codexEventConverter] Failed to parse function_call arguments as JSON:', error);
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
            if (!message) {
                return null;
            }
            return {
                userMessage: message
            };
        }

        if (eventType === 'agent_message') {
            const message = asString(payloadRecord.message);
            if (!message) {
                return null;
            }
            return {
                message: {
                    type: 'message',
                    message,
                    id: randomUUID()
                }
            };
        }

        if (eventType === 'agent_reasoning') {
            const message = asString(payloadRecord.text) ?? asString(payloadRecord.message);
            if (!message) {
                return null;
            }
            return {
                message: {
                    type: 'reasoning',
                    message,
                    id: randomUUID()
                }
            };
        }

        if (eventType === 'agent_reasoning_delta') {
            const delta = asString(payloadRecord.delta) ?? asString(payloadRecord.text) ?? asString(payloadRecord.message);
            if (!delta) {
                return null;
            }
            return {
                message: {
                    type: 'reasoning-delta',
                    delta
                }
            };
        }

        if (eventType === 'token_count') {
            const info = asRecord(payloadRecord.info);
            if (!info) {
                return null;
            }
            return {
                message: {
                    type: 'token_count',
                    info,
                    id: randomUUID()
                }
            };
        }

        if (eventType === 'thread_goal_updated') {
            const goal = asRecord(payloadRecord.goal);
            const threadId = asString(payloadRecord.thread_id)
                ?? asString(payloadRecord.threadId)
                ?? asString(goal?.thread_id)
                ?? asString(goal?.threadId);
            if (!goal || !threadId) {
                return null;
            }
            const turnId = asString(payloadRecord.turn_id) ?? asString(payloadRecord.turnId);
            return {
                message: {
                    type: 'thread_goal_updated',
                    thread_id: threadId,
                    ...(turnId ? { turn_id: turnId } : {}),
                    goal
                }
            };
        }

        if (eventType === 'thread_goal_cleared') {
            const threadId = asString(payloadRecord.thread_id) ?? asString(payloadRecord.threadId);
            if (!threadId) {
                return null;
            }
            return {
                message: {
                    type: 'thread_goal_cleared',
                    thread_id: threadId
                }
            };
        }

        return null;
    }

    if (type === 'response_item') {
        const itemType = asString(payloadRecord.type);
        if (!itemType) {
            return null;
        }

        if (itemType === 'function_call') {
            const name = asString(payloadRecord.name);
            const callId = extractCallId(payloadRecord);
            if (!name || !callId) {
                return null;
            }
            return {
                message: {
                    type: 'tool-call',
                    name,
                    callId,
                    input: parseArguments(payloadRecord.arguments),
                    id: randomUUID()
                }
            };
        }

        if (itemType === 'function_call_output') {
            const callId = extractCallId(payloadRecord);
            if (!callId) {
                return null;
            }
            return {
                message: {
                    type: 'tool-call-result',
                    callId,
                    output: payloadRecord.output,
                    id: randomUUID()
                }
            };
        }

        return null;
    }

    return null;
}
