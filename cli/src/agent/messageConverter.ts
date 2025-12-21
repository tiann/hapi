import type { AgentMessage, PlanItem } from './types';

export type CodexMessage =
    | { type: 'message'; message: string }
    | { type: 'tool-call'; name: string; callId: string; input: unknown }
    | { type: 'tool-call-result'; callId: string; output: unknown }
    | { type: 'plan'; entries: PlanItem[] }
    | { type: 'error'; message: string };

export function convertAgentMessage(message: AgentMessage): CodexMessage | null {
    switch (message.type) {
        case 'text':
            return { type: 'message', message: message.text };
        case 'tool_call':
            return {
                type: 'tool-call',
                name: message.name,
                callId: message.id,
                input: message.input
            };
        case 'tool_result':
            return {
                type: 'tool-call-result',
                callId: message.id,
                output: message.output
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
