import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { isObject } from '@hapi/protocol';
import type { RawJSONLines } from '../types';
import type { InlineMediaSource } from '@/modules/common/inlineMediaSource';
import { decodeGeneratedImageBase64, detectImageMimeType, registerGeneratedImage } from '@/modules/common/generatedImages';
import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';

export type ClaudeToolResultImageMessage = {
    type: 'generated-image';
    imageId: string;
    fileName: string;
    mimeType: string;
    id: string;
    source: InlineMediaSource;
};

type ToolUse = { name: string; path: string | null };

const MAX_TRACKED_TOOL_USES = 500;

/**
 * Images an agent looked at (Read of an image, screenshot MCP tools, ...) come
 * back as base64 `image` blocks inside main-thread tool results. Register them
 * in the generated-media cache so every client renders them inline like
 * display_image, and drop the base64 from the mirrored log line so the hub does
 * not store the same bytes again.
 */
export class ClaudeToolResultImages {
    private readonly toolUses = new Map<string, ToolUse>();

    /** Forward a transcript line, followed by the images its tool results returned. */
    send(client: Pick<ApiSessionClient, 'sendClaudeSessionMessage' | 'sendAgentMessage'>, message: RawJSONLines): void {
        const processed = this.process(message);
        client.sendClaudeSessionMessage(processed.message);
        for (const image of processed.images) {
            client.sendAgentMessage(image);
        }
    }

    process(message: RawJSONLines): { message: RawJSONLines; images: ClaudeToolResultImageMessage[] } {
        if (message.isSidechain) return { message, images: [] };
        if (message.type === 'assistant') {
            this.trackToolUses(message.message?.content);
            return { message, images: [] };
        }
        // Scanner lines are not schema-validated, so `message` may be missing.
        const blocks: unknown = message.type === 'user' ? message.message?.content : undefined;
        if (message.type !== 'user' || !Array.isArray(blocks)) {
            return { message, images: [] };
        }

        const images: ClaudeToolResultImageMessage[] = [];
        const content = blocks.map((block) => {
            if (!isObject(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || !Array.isArray(block.content)) {
                return block;
            }
            const toolUseId = block.tool_use_id;
            const toolUse = this.toolUses.get(toolUseId);
            let changed = false;
            const resultContent = block.content.map((part, index) => {
                const image = this.register(part, `${message.uuid}:${toolUseId}:${index}`, toolUse);
                if (!image) return part;
                images.push({
                    type: 'generated-image',
                    imageId: image.id,
                    fileName: image.fileName,
                    mimeType: image.mimeType,
                    id: image.id,
                    source: {
                        ingress: 'tool_result',
                        flavor: 'claude',
                        toolCallId: toolUseId,
                        ...(toolUse ? { toolName: toolUse.name } : {})
                    }
                });
                changed = true;
                return stripImageBlock(part);
            });
            return changed ? { ...block, content: resultContent } : block;
        });

        if (images.length === 0) return { message, images };
        return {
            message: {
                ...message,
                message: { ...message.message, content },
                ...(message.toolUseResult !== undefined ? { toolUseResult: stripImagePayloads(message.toolUseResult) } : {})
            },
            images
        };
    }

    private trackToolUses(content: unknown): void {
        if (!Array.isArray(content)) return;
        for (const block of content) {
            if (!isObject(block) || block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue;
            const input = isObject(block.input) ? block.input : {};
            const path = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
            this.toolUses.set(block.id, { name: block.name, path });
            if (this.toolUses.size > MAX_TRACKED_TOOL_USES) {
                const oldest = this.toolUses.keys().next().value;
                if (oldest) this.toolUses.delete(oldest);
            }
        }
    }

    private register(part: unknown, key: string, toolUse: ToolUse | undefined) {
        if (!isObject(part) || part.type !== 'image' || !isObject(part.source)) return null;
        const source = part.source;
        if (source.type !== 'base64' || typeof source.data !== 'string') return null;
        const bytes = decodeGeneratedImageBase64(source.data);
        const mimeType = bytes ? detectImageMimeType(bytes) : null;
        if (!bytes || !mimeType) return null;
        // Content-derived id: a re-sent transcript line maps to the same image.
        const id = createHash('sha256').update(key).digest('hex');
        // Claude may re-encode what it read (PNG -> JPEG), so the extension follows the bytes.
        const extension = mimeType.slice('image/'.length).replace('jpeg', 'jpg');
        const stem = toolUse?.path ? basename(toolUse.path, extname(toolUse.path)) : `image-${id.slice(0, 8)}`;
        const fileName = `${stem}.${extension}`;
        try {
            return registerGeneratedImage({ id, path: fileName, fileName, mimeType, bytes });
        } catch (error) {
            logger.debug('[claude] Failed to register tool-result image:', error instanceof Error ? error.message : String(error));
            return null;
        }
    }
}

function stripImageBlock(part: unknown): unknown {
    if (!isObject(part) || !isObject(part.source)) return part;
    const { data: _data, ...source } = part.source;
    return { ...part, source };
}

/** Drop base64 bytes from Claude's structured result (Read: `{ type: 'image', file: { base64 } }`). */
function stripImagePayloads(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripImagePayloads);
    if (!isObject(value)) return value;
    if (value.type === 'image') return stripImageBlock(stripBase64Field(value));
    return value;
}

function stripBase64Field(value: Record<string, unknown>): Record<string, unknown> {
    if (!isObject(value.file) || typeof value.file.base64 !== 'string') return value;
    const { base64: _base64, ...file } = value.file;
    return { ...value, file };
}
