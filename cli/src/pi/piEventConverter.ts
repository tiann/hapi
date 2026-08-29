import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { decodeGeneratedImageBase64, detectImageMimeType, registerGeneratedImage } from '@/modules/common/generatedImages';
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

/** Converts validated Pi lifecycle events to HAPI chat messages. */
export function convertPiEvent(event: PiAgentEvent): AgentMessage[] {
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
            return [{
                type: 'tool_result',
                id: parsed.data.toolCallId,
                output: parsed.data.result,
                status: parsed.data.isError ? 'failed' : 'completed',
            }];
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

const PI_IMAGE_EXTENSIONS: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif',
};

/**
 * Pi hands images back inside tool results as inline base64 content blocks
 * (e.g. `read` on an image file yields `{ type: 'image', data, mimeType }`).
 * Register each block as generated media and emit a `generated_image`
 * AgentMessage so the web client can render it via the generated-image blob
 * endpoint — mirroring the Codex `generated_image` flow.
 */
export function extractPiGeneratedImages(
    event: PiAgentEvent,
    resolveArgs: (toolCallId: string) => unknown,
): AgentMessage[] {
    if (event.type !== 'tool_execution_end') return [];
    const parsed = PiToolExecutionEndEventSchema.safeParse(event);
    if (!parsed.success) return [];
    const endEvent = parsed.data;
    const result = endEvent.result;
    const content = result !== null && typeof result === 'object'
        ? (result as { content?: unknown }).content
        : undefined;
    if (!Array.isArray(content)) return [];

    const args = resolveArgs(endEvent.toolCallId);
    const sourcePath = args !== null && typeof args === 'object'
        && typeof (args as { path?: unknown }).path === 'string'
        ? (args as { path: string }).path
        : undefined;

    const messages: AgentMessage[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'image') continue;
        const record = block as { data?: unknown; mimeType?: unknown };
        const data = typeof record.data === 'string' ? record.data : undefined;
        const mimeType = typeof record.mimeType === 'string' ? record.mimeType : undefined;
        if (!data || !mimeType || !mimeType.toLowerCase().startsWith('image/')) continue;
        try {
            const bytes = decodeGeneratedImageBase64(data);
            if (!bytes) continue;
            const detectedMimeType = detectImageMimeType(bytes);
            if (!detectedMimeType || detectedMimeType !== mimeType.toLowerCase()) continue;
            const media = registerGeneratedImage({
                id: randomUUID(),
                path: sourcePath ?? `${endEvent.toolCallId}${PI_IMAGE_EXTENSIONS[detectedMimeType] ?? '.bin'}`,
                fileName: sourcePath ? undefined : null,
                mimeType: detectedMimeType,
                bytes,
            });
            messages.push({
                type: 'generated_image',
                imageId: media.id,
                fileName: media.fileName,
                mimeType: media.mimeType,
                source: { ingress: 'tool_result', flavor: 'pi', toolCallId: endEvent.toolCallId },
            });
        } catch (error) {
            logger.debug(`[pi] Skipping undisplayable image from ${endEvent.toolName} (${endEvent.toolCallId}): ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return messages;
}
