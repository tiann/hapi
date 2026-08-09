import type { AttachmentMetadata, MessageMeta } from '@/api/types'

/**
 * Formats attachments for Claude by converting them to @path references.
 * Claude understands the @path format for file references.
 */
export function formatAttachmentsForClaude(attachments: AttachmentMetadata[] | undefined): string {
    if (!attachments || attachments.length === 0) {
        return ''
    }
    return attachments.map(a => `@${a.path}`).join(' ')
}

/**
 * Combines text and formatted attachments into a single prompt string.
 * Attachments are formatted as @path references and prepended to the text.
 *
 * Shape is part of the contract for `agySessionScanner.extractBodyText` —
 * do not change the `@path…\n\nbody` prefix without updating that matcher.
 */
export function formatMessageWithAttachments(
    text: string,
    attachments: AttachmentMetadata[] | undefined
): string {
    const attachmentText = formatAttachmentsForClaude(attachments)
    if (!attachmentText) {
        return text
    }
    if (!text) {
        return attachmentText
    }
    return `${attachmentText}\n\n${text}`
}

/**
 * Prepend a machine-parseable peer provenance line for the receiving agent
 * (#1203 / contract item 5). Kept separate from {@link formatMessageWithAttachments}
 * so agy's attachment-prefix matcher stays exact.
 */
export function annotatePeerDeliveryForAgent(
    text: string,
    meta: MessageMeta | undefined | null
): string {
    if (meta?.sentFrom !== 'peer') {
        return text
    }
    const id = meta.peer?.sourceSessionId?.trim() ?? ''
    if (!id) {
        return `From: peer (unattributed)\n\n${text}`
    }
    const name = meta.peer?.sourceName?.trim() ?? ''
    const header = name
        ? `From: /sessions/${id} (${name})`
        : `From: /sessions/${id}`
    return `${header}\n\n${text}`
}

/** Attachment formatting + peer provenance for agent-facing user prompts. */
export function formatUserMessageForAgent(
    text: string,
    attachments: AttachmentMetadata[] | undefined,
    meta?: MessageMeta | null
): string {
    return annotatePeerDeliveryForAgent(
        formatMessageWithAttachments(text, attachments),
        meta
    )
}
