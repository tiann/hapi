import type { AttachmentMetadata } from '@/api/types'
import path from 'node:path'

type AttachmentFormattingOptions = {
    agent?: 'claude' | 'codex' | 'gemini' | 'opencode' | 'generic'
    cwd?: string
}

function resolveAttachmentPathForCodex(filePath: string, cwd?: string): string {
    if (!cwd || !path.isAbsolute(filePath)) {
        return filePath
    }

    const relativePath = path.relative(cwd, filePath)
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return filePath
    }

    return relativePath
}

/**
 * Formats attachments for Claude by converting them to @path references.
 * Claude understands the @path format for file references.
 */
export function formatAttachmentsForClaude(
    attachments: AttachmentMetadata[] | undefined,
    options?: AttachmentFormattingOptions
): string {
    if (!attachments || attachments.length === 0) {
        return ''
    }

    return attachments.map((attachment) => {
        const attachmentPath = options?.agent === 'codex'
            ? resolveAttachmentPathForCodex(attachment.path, options.cwd)
            : attachment.path
        return `@${attachmentPath}`
    }).join(' ')
}

/**
 * Combines text and formatted attachments into a single prompt string.
 * Attachments are formatted as @path references and prepended to the text.
 */
export function formatMessageWithAttachments(
    text: string,
    attachments: AttachmentMetadata[] | undefined,
    options?: AttachmentFormattingOptions
): string {
    const trimmed = text.trimStart()
    if (trimmed.startsWith('/')) {
        // Keep slash commands untouched so agent CLIs can parse command mode correctly.
        return text
    }

    const attachmentText = formatAttachmentsForClaude(attachments, options)
    if (!attachmentText) {
        return text
    }
    if (!text) {
        return attachmentText
    }
    return `${attachmentText}\n\n${text}`
}
