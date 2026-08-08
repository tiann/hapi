import { randomUUID } from 'node:crypto';
import { INCLUSIVE_INPUT_TOKEN_USAGE_MARKER, type InclusiveInputTokenUsageMarker } from '@hapi/protocol/usage';
import type { AgentMessage, PlanItem } from './types';
import type { InlineMediaSource } from '@/modules/common/inlineMediaSource';

export type CodexMessage =
    | { type: 'message'; message: string; id?: string; streamSnapshot?: boolean }
    | { type: 'reasoning'; message: string; id: string }
    | {
        type: 'token_count';
        model: string | null;
        usageSchema: InclusiveInputTokenUsageMarker['usageSchema'];
        inputTokenSemantics: InclusiveInputTokenUsageMarker['inputTokenSemantics'];
        info: {
            total: {
                inputTokens: number;
                outputTokens: number;
                totalTokens?: number;
                thoughtTokens?: number;
                cachedInputTokens?: number;
                cacheWriteInputTokens?: number;
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
        nativeTitle?: string;
        nativeKind?: string;
        progress?: unknown;
    }
    | {
        type: 'tool-call-result';
        callId: string;
        output: unknown;
        is_error?: boolean;
    }
    | { type: 'plan'; entries: PlanItem[] }
    | { type: 'error'; message: string }
    | {
        type: 'generated-image';
        imageId: string;
        fileName: string;
        mimeType: string;
        id: string;
        source?: InlineMediaSource;
    };

export function convertAgentMessage(message: AgentMessage, model?: string | null): CodexMessage | null {
    switch (message.type) {
        case 'text':
            return {
                type: 'message',
                message: message.text,
                ...(message.id !== undefined ? { id: message.id } : {}),
                ...(message.streamSnapshot === true ? { streamSnapshot: true } : {})
            };
        case 'reasoning':
            // AgentMessage uses `text` (consistent with the `text` variant);
            // the wire-level CodexMessage uses `message` to match the
            // existing reasoning format emitted by the Codex path.
            return { type: 'reasoning', message: message.text, id: message.id ?? randomUUID() };
        case 'usage':
            return {
                type: 'token_count',
                model: typeof model === 'string' && model.trim() ? model.trim() : null,
                ...INCLUSIVE_INPUT_TOKEN_USAGE_MARKER,
                info: {
                    total: {
                        inputTokens: message.inputTokens
                            + (message.cacheReadTokens ?? 0)
                            + (message.cacheCreationTokens ?? 0),
                        outputTokens: message.outputTokens,
                        totalTokens: message.totalTokens,
                        thoughtTokens: message.thoughtTokens,
                        cachedInputTokens: message.cacheReadTokens,
                        ...(message.cacheCreationTokens !== undefined
                            ? { cacheWriteInputTokens: message.cacheCreationTokens }
                            : {})
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
                status: message.status,
                ...(message.title ? { nativeTitle: message.title } : {}),
                ...(message.kind ? { nativeKind: message.kind } : {}),
                ...(message.progress !== undefined ? { progress: message.progress } : {})
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
        case 'generated_image':
            return {
                type: 'generated-image',
                imageId: message.imageId,
                fileName: message.fileName,
                mimeType: message.mimeType,
                id: randomUUID(),
                source: message.source,
            };
        case 'error':
            return { type: 'error', message: message.message };
        case 'turn_complete':
            return null;
        default: {
            // Unreachable while every AgentMessage variant is handled above —
            // the `never` binding is what enforces that at compile time. The
            // runtime return is deliberately `null` rather than the message
            // itself: callers forward a non-null result straight into the chat
            // stream, so echoing an unrecognized shape here would put a raw
            // object on screen instead of failing closed.
            const _exhaustive: never = message;
            void _exhaustive;
            return null;
        }
    }
}
