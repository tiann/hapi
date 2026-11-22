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

/**
 * Builds ACP `PromptContent[]` blocks for an Antigravity turn, attaching inline
 * base64 images when `backend.supportsImagePrompts()` is true or falling back
 * to `@path` text references when unavailable.
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
        const refs = images.map((image) => `@${image.path}`).join(' ');
        return [{ type: 'text', text: text ? `${refs}\n\n${text}` : refs }];
    }

    const prompt: PromptContent[] = [{ type: 'text', text }];
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
            prompt.push({
                type: 'image',
                data: data.toString('base64'),
                mimeType: normalizeImageMimeType(image.mimeType)
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            opts.onNotice(`Could not attach image ${image.filename ?? image.path}: ${detail}`);
        }
    }
    return prompt;
}
