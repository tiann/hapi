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

export type PeerAnnotationPlacement = 'prefix' | 'suffix'

function peerProvenanceLine(meta: MessageMeta): string {
    const id = meta.peer?.sourceSessionId?.trim() ?? ''
    if (!id) {
        return 'From: peer (unattributed)'
    }
    const name = meta.peer?.sourceName
        ?.replace(/[\r\n\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() ?? ''
    // Keep Name: on its own line so parentheses in titles cannot split From:.
    return name
        ? `From: /sessions/${id}\nName: ${name}`
        : `From: /sessions/${id}`
}

/**
 * Add a machine-parseable peer provenance line for the receiving agent
 * (#1203). Kept separate from {@link formatMessageWithAttachments}
 * so agy's attachment-prefix matcher stays exact.
 *
 * Default placement is prefix. Pi uses suffix so slash/skill commands remain
 * the first line (`formatPiUserMessage` contract) for operator messages;
 * peer deliveries skip slash parse entirely and still get a reply address.
 */
export function annotatePeerDeliveryForAgent(
    text: string,
    meta: MessageMeta | undefined | null,
    placement: PeerAnnotationPlacement = 'prefix'
): string {
    if (meta?.sentFrom !== 'peer') {
        return text
    }
    const line = peerProvenanceLine(meta)
    if (!text) {
        return line
    }
    return placement === 'suffix'
        ? `${text}\n\n${line}`
        : `${line}\n\n${text}`
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
