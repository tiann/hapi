import type { AttachmentMetadata } from '@/api/types'
import type { AcpSdkBackend } from '@/agent/backends/acp'
import type { PromptContent } from '@/agent/types'
import { MAX_UPLOAD_BYTES } from '@/modules/common/attachmentLimits'
import { readBoundedAttachmentFile } from '@/modules/common/attachmentFile'
import {
    isAuthorizedUploadFile,
    isPathWithinUploadDir,
    type UploadFileIdentity
} from '@/modules/common/handlers/uploads'
import type { BerryImageAttachment } from '../types'

/**
 * Image-attachment plumbing for the berry flavor. This is a deliberate
 * minimal copy of cli/src/dsh/utils/dshPromptContent.ts (the v29.3 inline
 * image pattern) kept inside cli/src/berry/ instead of importing across
 * flavor areas; berry advertises the same
 * `agentCapabilities.promptCapabilities.image` gate.
 */

/** MIME types berry accepts as inline canonical base64 image blocks. */
const INLINE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Whether the attachment can be upgraded to an ACP image content block
 * (png/jpeg/webp/gif only — the formats promptCapabilities.image accepts;
 * other attachments keep the @path text form). */
export function isInlineImageAttachment(attachment: AttachmentMetadata): boolean {
    const mimeType = attachment.mimeType?.toLowerCase().trim()
    if (!mimeType) return false
    return INLINE_IMAGE_MIME_TYPES.has(mimeType) || mimeType === 'image/jpg'
}

function normalizeImageMimeType(mimeType: string): string {
    const normalized = mimeType.toLowerCase().trim()
    return normalized === 'image/jpg' ? 'image/jpeg' : normalized
}

/** Extract the image attachments that should ride a queued turn's mode. */
export function berryImageAttachmentsFor(
    attachments: AttachmentMetadata[] | undefined
): { imageAttachments?: BerryImageAttachment[] } {
    const images = (attachments ?? [])
        .filter((attachment) => isInlineImageAttachment(attachment))
        .map((attachment) => ({
            path: attachment.path,
            mimeType: attachment.mimeType,
            ...(attachment.filename ? { filename: attachment.filename } : {})
        }))
    return images.length > 0 ? { imageAttachments: images } : {}
}

/**
 * Text form of a user turn: NON-image attachments keep the @path reference
 * form (the model can read them with its own file tools). Inline-capable
 * images are excluded here and travel as mode metadata instead, so they are
 * never duplicated as both a path reference and a content block.
 */
export function formatBerryUserMessage(
    text: string,
    attachments: AttachmentMetadata[] | undefined
): string {
    const refs = (attachments ?? [])
        .filter((attachment) => !isInlineImageAttachment(attachment))
        .map((attachment) => `@${attachment.path}`)
        .join(' ')
    if (!refs) return text
    return text ? `${refs}\n\n${text}` : refs
}

/**
 * Build the ACP prompt content for one berry turn.
 *
 * Image attachments become `{type:'image', data, mimeType}` blocks gated on
 * the backend's advertised `promptCapabilities.image` (berry
 * 0.1.1-alpha.10+). Files are read through the shared bounded reader with
 * per-session upload authorization; an unreadable image degrades to a
 * status notice instead of failing the whole turn. When the capability is
 * absent the images fall back to the legacy @path text form so the model
 * keeps a reference it can read itself.
 */
export async function buildBerryPromptContent(
    backend: AcpSdkBackend,
    text: string,
    imageAttachments: BerryImageAttachment[] | undefined,
    opts: {
        sessionId: string | undefined
        onNotice: (message: string) => void
    }
): Promise<PromptContent[]> {
    const images = imageAttachments ?? []
    if (images.length === 0) {
        return [{ type: 'text', text }]
    }
    if (!backend.supportsImagePrompts()) {
        const refs = images.map((image) => `@${image.path}`).join(' ')
        return [{ type: 'text', text: text ? `${refs}\n\n${text}` : refs }]
    }

    const prompt: PromptContent[] = [{ type: 'text', text }]
    let totalImageBytes = 0
    for (const image of images) {
        try {
            if (!isPathWithinUploadDir(image.path, opts.sessionId)) {
                throw new Error('invalid upload path')
            }
            const data = await readBoundedAttachmentFile(
                image.path,
                MAX_UPLOAD_BYTES - totalImageBytes,
                (identity: UploadFileIdentity) =>
                    isAuthorizedUploadFile(image.path, opts.sessionId, identity)
            )
            totalImageBytes += data.length
            prompt.push({
                type: 'image',
                data: data.toString('base64'),
                mimeType: normalizeImageMimeType(image.mimeType)
            })
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            opts.onNotice(`Could not attach image ${image.filename ?? image.path}: ${detail}`)
        }
    }
    return prompt
}
