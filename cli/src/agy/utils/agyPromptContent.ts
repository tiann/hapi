import type { AttachmentMetadata } from '@/api/types';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import type { PromptContent } from '@/agent/types';
import { MAX_UPLOAD_BYTES } from '@/modules/common/attachmentLimits';
import { readBoundedAttachmentFile } from '@/modules/common/attachmentFile';
import {
    isAuthorizedUploadFile,
    isPathWithinUploadDir,
    type UploadFileIdentity
} from '@/modules/common/handlers/uploads';
import type { AgyImageAttachment } from '../types';

/** MIME types accepted as inline canonical base64 image blocks on Antigravity ACP. */
const INLINE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Returns whether an attachment can be upgraded to an ACP image content block
 * (`png`/`jpeg`/`webp`/`gif`; other attachments keep the `@path` text form).
 */
export function isAgyInlineImageAttachment(attachment: AttachmentMetadata): boolean {
    const mimeType = attachment.mimeType?.toLowerCase().trim();
    if (!mimeType) return false;
    return INLINE_IMAGE_MIME_TYPES.has(mimeType) || mimeType === 'image/jpg';
}

function normalizeImageMimeType(mimeType: string): string {
    const normalized = mimeType.toLowerCase().trim();
    return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

/** Extracts inline-capable image attachments that ride a queued `AgyMode`. */
export function agyImageAttachmentsFor(
    attachments: AttachmentMetadata[] | undefined
): { imageAttachments?: AgyImageAttachment[] } {
    const images = (attachments ?? [])
        .filter((attachment) => isAgyInlineImageAttachment(attachment))
        .map((attachment) => ({
            path: attachment.path,
            mimeType: attachment.mimeType,
            ...(attachment.filename ? { filename: attachment.filename } : {})
        }));
    return images.length > 0 ? { imageAttachments: images } : {};
}

/**
 * Formats user text for a queued turn: non-image attachments keep `@path` text
 * references while inline-capable images travel in `AgyMode.imageAttachments`
 * so they are not duplicated as both text paths and content blocks.
 */
export function formatAgyUserMessage(
    text: string,
    attachments: AttachmentMetadata[] | undefined
): string {
    const refs = (attachments ?? [])
        .filter((attachment) => !isAgyInlineImageAttachment(attachment))
        .map((attachment) => `@${attachment.path}`)
        .join(' ');
    if (!refs) return text;
    return text ? `${refs}\n\n${text}` : refs;
}

function splitAttachmentHeader(text: string): { header: string; body: string; hasSeparator: boolean } {
    const sepIdx = text.indexOf('\n\n');
    if (sepIdx < 0) {
        return { header: text, body: '', hasSeparator: false };
    }
    return {
        header: text.slice(0, sepIdx),
        body: text.slice(sepIdx + 2),
        hasSeparator: true
    };
}

function findHeaderTokenIndex(header: string, token: string): number {
    if (!token) return -1;
    let fromIndex = 0;
    while (fromIndex <= header.length) {
        const idx = header.indexOf(token, fromIndex);
        if (idx < 0) return -1;
        const end = idx + token.length;
        const leftOk = idx === 0 || header[idx - 1] === ' ';
        const rightOk = end === header.length || header[end] === ' ';
        if (leftOk && rightOk) return idx;
        fromIndex = idx + 1;
    }
    return -1;
}

function removeTokenFromHeader(header: string, token: string): string {
    const idx = findHeaderTokenIndex(header, token);
    if (idx < 0) return header;
    const before = header.slice(0, idx);
    const after = header.slice(idx + token.length);
    if (before.endsWith(' ') && after.startsWith(' ')) {
        return `${before.slice(0, -1)}${after}`;
    }
    if (before.endsWith(' ')) {
        return `${before.slice(0, -1)}${after}`;
    }
    if (after.startsWith(' ')) {
        return `${before}${after.slice(1)}`;
    }
    return `${before}${after}`;
}

/**
 * Removes `@path` tokens for images that were encoded into ACP image blocks,
 * preserving non-image `@path` tokens, failed image `@path` tokens, and body text.
 */
function stripAttachedImageRefs(text: string, attachedPaths: readonly string[]): string {
    if (attachedPaths.length === 0 || !text) return text;
    const { header, body, hasSeparator } = splitAttachmentHeader(text);
    let remainingHeader = header;
    for (const path of attachedPaths) {
        remainingHeader = removeTokenFromHeader(remainingHeader, `@${path}`);
    }
    remainingHeader = remainingHeader.trim();
    if (!hasSeparator) {
        return remainingHeader;
    }
    if (!remainingHeader) return body;
    if (!body) return remainingHeader;
    return `${remainingHeader}\n\n${body}`;
}

/**
 * Builds ACP `PromptContent[]` blocks for an Antigravity turn, attaching inline
 * base64 images when `backend.supportsImagePrompts()` is true (stripping only
 * those successfully encoded `@path` tokens from the text header) or preserving
 * `@path` text references when unavailable or unreadable.
 */
export async function buildAgyPromptContent(
    backend: Pick<AcpSdkBackend, 'supportsImagePrompts'>,
    text: string,
    imageAttachments: AgyImageAttachment[] | undefined,
    opts: {
        sessionId: string | undefined;
        onNotice: (message: string) => void;
    }
): Promise<PromptContent[]> {
    const images = imageAttachments ?? [];
    if (images.length === 0) {
        return [{ type: 'text', text }];
    }
    const supportsImages = typeof backend.supportsImagePrompts === 'function'
        && backend.supportsImagePrompts();
    if (!supportsImages) {
        const { header, body, hasSeparator } = splitAttachmentHeader(text);
        const missingRefs = images
            .filter((image) => findHeaderTokenIndex(header, `@${image.path}`) < 0)
            .map((image) => `@${image.path}`);
        if (missingRefs.length === 0) {
            return [{ type: 'text', text }];
        }
        const missingStr = missingRefs.join(' ');
        if (hasSeparator) {
            const nextHeader = header ? `${missingStr} ${header}` : missingStr;
            return [{ type: 'text', text: body ? `${nextHeader}\n\n${body}` : nextHeader }];
        }
        return [{ type: 'text', text: text ? `${missingStr}\n\n${text}` : missingStr }];
    }

    const imageBlocks: PromptContent[] = [];
    const attachedPaths: string[] = [];
    let totalImageBytes = 0;
    for (const image of images) {
        try {
            if (!isPathWithinUploadDir(image.path, opts.sessionId)) {
                throw new Error('invalid upload path');
            }
            const data = await readBoundedAttachmentFile(
                image.path,
                MAX_UPLOAD_BYTES - totalImageBytes,
                (identity: UploadFileIdentity) =>
                    isAuthorizedUploadFile(image.path, opts.sessionId, identity)
            );
            totalImageBytes += data.length;
            imageBlocks.push({
                type: 'image',
                data: data.toString('base64'),
                mimeType: normalizeImageMimeType(image.mimeType)
            });
            attachedPaths.push(image.path);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            opts.onNotice(`Could not attach image ${image.filename ?? image.path}: ${detail}`);
        }
    }

    const remainingText = stripAttachedImageRefs(text, attachedPaths);
    const prompt: PromptContent[] = [];
    if (remainingText.length > 0 || imageBlocks.length === 0) {
        prompt.push({ type: 'text', text: remainingText });
    }
    prompt.push(...imageBlocks);
    return prompt;
}
