import type { NormalizedMessage } from '@/chat/types'
import type { AttachmentMetadata } from '@/types/api'
import { isObject } from '@hapi/protocol'
import { getSafeAttachmentPreviewUrl } from '@/lib/safeAttachmentPreviewUrl'

const CODEX_SYNC_PSEUDO_USER_PREFIXES = [
    '<subagent_notification>',
    '<turn_aborted>'
]

function parseAttachments(raw: unknown): AttachmentMetadata[] | undefined {
    if (!Array.isArray(raw)) return undefined
    const attachments: AttachmentMetadata[] = []
    for (const item of raw) {
        if (
            isObject(item) &&
            typeof item.id === 'string' &&
            typeof item.filename === 'string' &&
            typeof item.mimeType === 'string' &&
            typeof item.size === 'number' &&
            typeof item.path === 'string'
        ) {
            attachments.push({
                id: item.id,
                filename: item.filename,
                mimeType: item.mimeType,
                size: item.size,
                path: item.path,
                previewUrl: getSafeAttachmentPreviewUrl(item.previewUrl, item.mimeType)
            })
        }
    }
    return attachments.length > 0 ? attachments : undefined
}

function extractUserText(content: unknown): string | null {
    if (typeof content === 'string') {
        return content
    }

    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
        return content.text
    }

    return null
}

export function isSkippableUserRecord(content: unknown, localId: string | null, meta?: unknown): boolean {
    const isCodexSyncArtifact = (typeof localId === 'string' && localId.startsWith('codex:'))
        || (isObject(meta) && meta.sentFrom === 'codex-desktop-sync')

    if (!isCodexSyncArtifact) {
        return false
    }

    const text = extractUserText(content)
    if (typeof text !== 'string') {
        return false
    }

    const trimmed = text.trimStart()
    return CODEX_SYNC_PSEUDO_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

export function normalizeUserRecord(
    messageId: string,
    localId: string | null,
    createdAt: number,
    content: unknown,
    meta?: unknown
): NormalizedMessage | null {
    if (typeof content === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            content: { type: 'text', text: content },
            isSidechain: false,
            meta
        }
    }

    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
        const attachments = parseAttachments(content.attachments)
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            content: { type: 'text', text: content.text, attachments },
            isSidechain: false,
            meta
        }
    }

    return null
}
