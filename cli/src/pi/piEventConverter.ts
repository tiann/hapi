import { logger } from '@/ui/logger';
import { registerGeneratedImageFromAcpBlock } from '@/modules/common/generatedImages';
import type { AgentMessage } from '@/agent/types';
import {
    PiToolExecutionEndEventSchema,
    PiToolExecutionStartEventSchema,
    PiToolExecutionUpdateEventSchema,
} from './schemas';
import type { PiAgentEvent, PiContextUsage, PiTurnEndEvent, PiUsage } from './types';

function hasMeaningfulUsage(usage: PiUsage | undefined): usage is PiUsage {
    return usage !== undefined && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0;
}

/** Builds a turn usage update after Pi's session-stats request settles. */
export function convertPiTurnUsage(
    event: PiTurnEndEvent,
    contextUsage: PiContextUsage | null | undefined,
): AgentMessage | null {
    const usage = event.message?.usage;
    if (!hasMeaningfulUsage(usage) || contextUsage === null) return null;
    return {
        type: 'usage',
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.cacheRead,
        cacheCreationTokens: usage.cacheWrite,
        contextTokens: contextUsage?.tokens ?? usage.totalTokens,
        contextWindow: contextUsage?.contextWindow,
    };
}

/** Builds a context-only usage update from Pi's post-compaction estimate. */
export function convertPiCompactionUsage(estimatedTokensAfter: number | undefined): AgentMessage | null {
    if (estimatedTokensAfter === undefined || !Number.isFinite(estimatedTokensAfter) || estimatedTokensAfter < 0) return null;
    return {
        type: 'usage',
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: estimatedTokensAfter,
    };
}

/**
 * Splits a structured Pi tool result ({ content: TextContent[] | ImageContent[], ... })
 * into displayable text and image blocks. Returns null for legacy string results
 * so callers keep the pass-through behavior.
 */
export function splitPiToolResult(result: unknown): { text: string; images: unknown[] } | null {
    if (!result || typeof result !== 'object' || !Array.isArray((result as { content?: unknown }).content)) {
        return null;
    }
    const text: string[] = [];
    const images: unknown[] = [];
    for (const block of (result as { content: unknown[] }).content) {
        if (!block || typeof block !== 'object') {
            continue;
        }
        const record = block as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') {
            text.push(record.text);
        } else if (record.type === 'image') {
            images.push(block);
        }
    }
    return { text: text.join('\n'), images };
}

/** Converts validated Pi lifecycle events to HAPI chat messages. */
export async function convertPiEvent(event: PiAgentEvent): Promise<AgentMessage[]> {
    switch (event.type) {
        case 'tool_execution_start': {
            const parsed = PiToolExecutionStartEventSchema.safeParse(event);
            if (!parsed.success) return [];
            return [{
                type: 'tool_call',
                id: parsed.data.toolCallId,
                name: parsed.data.toolName,
                input: parsed.data.args,
                status: 'in_progress',
            }];
        }
        case 'tool_execution_update': {
            const parsed = PiToolExecutionUpdateEventSchema.safeParse(event);
            if (!parsed.success) return [];
            return [{
                type: 'tool_call',
                id: parsed.data.toolCallId,
                name: parsed.data.toolName,
                input: parsed.data.args,
                status: 'in_progress',
                progress: parsed.data.partialResult,
            }];
        }
        case 'tool_execution_end': {
            const parsed = PiToolExecutionEndEventSchema.safeParse(event);
            if (!parsed.success) return [];

            const { toolCallId, result, isError } = parsed.data;
            if (isError) {
                return [{
                    type: 'tool_result',
                    id: toolCallId,
                    output: result,
                    status: 'failed',
                }];
            }

            const split = splitPiToolResult(result);
            if (!split) {
                return [{
                    type: 'tool_result',
                    id: toolCallId,
                    output: result,
                    status: 'completed',
                }];
            }

            const messages: AgentMessage[] = [{
                type: 'tool_result',
                id: toolCallId,
                output: split.text,
                status: 'completed',
            }];

            // Inline image blocks (e.g. from the hapi_display_image extension or
            // any tool that hands back ImageContent) land in the chat via the
            // same generated-image pipeline the ACP backend already uses.
            for (const block of split.images) {
                try {
                    const image = await registerGeneratedImageFromAcpBlock(block);
                    if (!image) {
                        continue;
                    }
                    messages.push({
                        type: 'generated_image',
                        imageId: image.id,
                        fileName: image.fileName,
                        mimeType: image.mimeType,
                        source: {
                            ingress: 'tool_result',
                            toolName: parsed.data.toolName,
                            toolCallId,
                        },
                    });
                } catch (error) {
                    logger.debug(
                        '[pi] Failed to register tool-result image:',
                        error instanceof Error ? error.message : String(error)
                    );
                }
            }
            return messages;
        }
        case 'turn_end': {
            const turn = event as PiTurnEndEvent;
            return [{ type: 'turn_complete', stopReason: turn.message?.stopReason ?? 'stop' }];
        }
        case 'agent_start':
        case 'agent_end':
        case 'agent_settled':
        case 'turn_start':
        case 'message_start':
        case 'message_update':
        case 'message_end':
        case 'extension_ui_request':
        case 'keep_alive':
        case 'response':
            return [];
        default:
            logger.debug(`[pi] Unknown event type: ${event.type}`);
            return [];
    }
}
