import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@/ui/logger';

const CodexSessionEventSchema = z.object({
    timestamp: z.string().optional(),
    type: z.string(),
    payload: z.unknown().optional(),
    hapiSidechain: z.object({
        parentToolCallId: z.string()
    }).optional()
});

export type CodexSessionEvent = z.infer<typeof CodexSessionEventSchema>;

type CodexSidechainMeta = {
    parentToolCallId: string;
};

export type CodexMessage = {
    type: 'message';
    message: string;
    id: string;
    isSidechain?: true;
    parentToolCallId?: string;
} | {
    type: 'reasoning';
    message: string;
    id: string;
    isSidechain?: true;
    parentToolCallId?: string;
} | {
    type: 'reasoning-delta';
    delta: string;
    isSidechain?: true;
    parentToolCallId?: string;
} | {
    type: 'token_count';
    info: Record<string, unknown>;
    id: string;
    isSidechain?: true;
    parentToolCallId?: string;
} | {
    type: 'tool-call';
    name: string;
    callId: string;
    input: unknown;
    id: string;
    isSidechain?: true;
    parentToolCallId?: string;
} | {
    type: 'tool-call-result';
    callId: string;
    output: unknown;
    id: string;
    isSidechain?: true;
    parentToolCallId?: string;
};

export type CodexConversionResult = {
    sessionId?: string;
    message?: CodexMessage;
    userMessage?: string;
    userMessageMeta?: {
        isSidechain: true;
        sidechainKey: string;
    };
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
            logger.debug('[codexEventConverter] Failed to parse function_call arguments as JSON:', error);
        }
    }

    return value;
}

function getSidechainMeta(rawEvent: z.infer<typeof CodexSessionEventSchema>): CodexSidechainMeta | null {
    return rawEvent.hapiSidechain ?? null;
}

function applySidechainMeta<T extends CodexMessage>(
    message: T,
    sidechainMeta: CodexSidechainMeta | null
): T {
    if (!sidechainMeta) {
        return message;
    }

    return {
        ...message,
        isSidechain: true,
        parentToolCallId: sidechainMeta.parentToolCallId
    };
}

function normalizeCodexToolName(name: string): string {
    switch (name) {
        case 'exec_command':
            return 'CodexBash';
        case 'write_stdin':
            return 'CodexWriteStdin';
        case 'spawn_agent':
            return 'CodexSpawnAgent';
        case 'wait_agent':
            return 'CodexWaitAgent';
        case 'send_input':
            return 'CodexSendInput';
        case 'close_agent':
            return 'CodexCloseAgent';
        default:
            return name;
    }
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
    const sidechainMeta = getSidechainMeta(parsed.data);

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
            const result: CodexConversionResult = {
                userMessage: message
            };
            if (sidechainMeta) {
                result.userMessageMeta = {
                    isSidechain: true,
                    sidechainKey: sidechainMeta.parentToolCallId
                };
            }
            return result;
        }

        if (eventType === 'agent_message') {
            const message = asString(payloadRecord.message);
            if (!message) {
                return null;
            }
            return {
                message: applySidechainMeta({
                    type: 'message',
                    message,
                    id: randomUUID()
                }, sidechainMeta)
            };
        }

        if (eventType === 'agent_reasoning') {
            const message = asString(payloadRecord.text) ?? asString(payloadRecord.message);
            if (!message) {
                return null;
            }
            return {
                message: applySidechainMeta({
                    type: 'reasoning',
                    message,
                    id: randomUUID()
                }, sidechainMeta)
            };
        }

        if (eventType === 'agent_reasoning_delta') {
            const delta = asString(payloadRecord.delta) ?? asString(payloadRecord.text) ?? asString(payloadRecord.message);
            if (!delta) {
                return null;
            }
            return {
                message: applySidechainMeta({
                    type: 'reasoning-delta',
                    delta
                }, sidechainMeta)
            };
        }

        if (eventType === 'token_count') {
            const info = asRecord(payloadRecord.info);
            if (!info) {
                return null;
            }
            return {
                message: applySidechainMeta({
                    type: 'token_count',
                    info,
                    id: randomUUID()
                }, sidechainMeta)
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
                message: applySidechainMeta({
                    type: 'tool-call',
                    name: normalizeCodexToolName(name),
                    callId,
                    input: parseArguments(payloadRecord.arguments),
                    id: randomUUID()
                }, sidechainMeta)
            };
        }

        if (itemType === 'function_call_output') {
            const callId = extractCallId(payloadRecord);
            if (!callId) {
                return null;
            }
            return {
                message: applySidechainMeta({
                    type: 'tool-call-result',
                    callId,
                    output: payloadRecord.output,
                    id: randomUUID()
                }, sidechainMeta)
            };
        }

        return null;
    }

    return null;
}
