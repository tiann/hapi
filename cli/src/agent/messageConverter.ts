import { randomUUID } from 'node:crypto';
import type { AgentMessage, PlanItem } from './types';

export type CodexMessage =
    | { type: 'message'; message: string; id?: string }
    | { type: 'reasoning'; message: string; id: string }
    | {
        type: 'token_count';
        info: {
            total: {
                inputTokens: number;
                outputTokens: number;
                totalTokens?: number;
                thoughtTokens?: number;
                cachedInputTokens?: number;
            };
            contextTokens?: number;
            modelContextWindow?: number;
        };
    }
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
            // Preserve a caller-provided id when present (Pi uses it as a
            // streamId for web-side dedup) so the wire format can dedup
            // delta bursts.
            return { type: 'message', message: message.text, ...(message.id !== undefined ? { id: message.id } : {}) };
        case 'reasoning':
            // AgentMessage uses `text` (consistent with the `text` variant);
            // the wire-level CodexMessage uses `message` to match the
            // existing reasoning format emitted by the Codex path.
            return { type: 'reasoning', message: message.text, id: message.id ?? randomUUID() };
        case 'usage':
            return {
                type: 'token_count',
                info: {
                    total: {
                        inputTokens: message.inputTokens,
                        outputTokens: message.outputTokens,
                        totalTokens: message.totalTokens,
                        thoughtTokens: message.thoughtTokens,
                        cachedInputTokens: message.cacheReadTokens
                    },
                    contextTokens: message.contextTokens,
                    modelContextWindow: message.contextWindow
                }
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
