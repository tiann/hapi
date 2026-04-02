import type { NormalizedMessage } from '@/chat/types'
import type { AttachmentMetadata } from '@/types/api'
import { isObject } from '@hapi/protocol'

function normalizeSidechainMeta(meta: unknown): Pick<NormalizedMessage, 'isSidechain' | 'sidechainKey'> | null {
    if (!isObject(meta)) return null
    if (meta.isSidechain !== true || typeof meta.sidechainKey !== 'string') return null
    return {
        isSidechain: true,
        sidechainKey: meta.sidechainKey
    }
}

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
                previewUrl: typeof item.previewUrl === 'string' ? item.previewUrl : undefined
            })
        }
    }
    return attachments.length > 0 ? attachments : undefined
}

export function normalizeUserRecord(
    messageId: string,
    localId: string | null,
    createdAt: number,
    content: unknown,
    meta?: unknown
): NormalizedMessage | null {
    if (typeof content === 'string') {
        const sidechain = normalizeSidechainMeta(meta)
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            content: { type: 'text', text: content },
            isSidechain: sidechain?.isSidechain ?? false,
            ...(sidechain ? { sidechainKey: sidechain.sidechainKey } : {}),
            meta
        }
    }

    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
        const attachments = parseAttachments(content.attachments)
        const sidechain = normalizeSidechainMeta(meta)
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            content: { type: 'text', text: content.text, attachments },
            isSidechain: sidechain?.isSidechain ?? false,
            ...(sidechain ? { sidechainKey: sidechain.sidechainKey } : {}),
            meta
        }
    }

    return null
}
