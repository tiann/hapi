import type { AgentMessage, PlanItem } from './types';

export type CodexMessage =
    | { type: 'message'; message: string }
    | { type: 'reasoning'; message: string }
    | { type: 'moa-reference'; label: string; message: string; index?: number; count?: number }
    | { type: 'moa-aggregating'; aggregator?: string }
    | {
        type: 'tool-call';
        name: string;
        callId: string;
        input: unknown;
        status?: 'pending' | 'in_progress' | 'completed' | 'failed';
    }
    | {
        type: 'tool-call-result';
        callId: string;
        output: unknown;
        is_error?: boolean;
    }
    | { type: 'plan'; entries: PlanItem[] }
    | { type: 'error'; message: string };

export function convertAgentMessage(message: AgentMessage): CodexMessage | null {
    switch (message.type) {
        case 'text':
            return { type: 'message', message: message.text };
        case 'reasoning':
            return { type: 'reasoning', message: message.text } as CodexMessage;
        case 'user_message':
            return null;
        case 'title':
            return null;
        case 'moa_reference':
            return {
                type: 'moa-reference',
                label: message.label,
                message: message.text,
                ...(message.index !== undefined ? { index: message.index } : {}),
                ...(message.count !== undefined ? { count: message.count } : {})
            };
        case 'moa_aggregating':
            return {
                type: 'moa-aggregating',
                ...(message.aggregator ? { aggregator: message.aggregator } : {})
            };
        case 'tool_call':
            return {
                type: 'tool-call',
                name: message.name,
                callId: message.id,
                input: message.input,
                status: message.status
            };
        case 'tool_result':
            return {
                type: 'tool-call-result',
                callId: message.id,
                output: message.output,
                is_error: message.status === 'failed'
            };
        case 'plan':
            return {
                type: 'plan',
                entries: message.items
            };
        case 'error':
            return { type: 'error', message: message.message };
        case 'turn_complete':
            return null;
        default: {
            const _exhaustive: never = message;
            return _exhaustive;
        }
    }
}
