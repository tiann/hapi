import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { ChatBlock, NormalizedMessage, UserTextBlock } from '@/chat/types'
import type { DecryptedMessage } from '@/types/api'

export type ConversationOutlineItem = {
    id: string
    targetMessageId: string
    kind: 'user'
    label: string
    createdAt: number
}

const MAX_OUTLINE_LABEL_LENGTH = 96

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

export function truncateOutlineLabel(value: string, maxLength = MAX_OUTLINE_LABEL_LENGTH): string {
    const normalized = collapseWhitespace(value)
    if (normalized.length <= maxLength) {
        return normalized
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

export function toConversationOutlineTargetMessageId(messageId: string): string {
    return `user:${messageId}`
}

export function userBlockToOutlineItem(block: UserTextBlock): ConversationOutlineItem {
    const label = truncateOutlineLabel(block.text) || 'Empty message'
    return {
        id: `outline:user:${block.id}`,
        targetMessageId: toConversationOutlineTargetMessageId(block.id),
        kind: 'user',
        label,
        createdAt: block.createdAt
    }
}

export function normalizedMessageToOutlineItem(message: NormalizedMessage): ConversationOutlineItem | null {
    if (message.role !== 'user' || message.content.type !== 'text') {
        return null
    }

    return userBlockToOutlineItem({
        kind: 'user-text',
        id: message.id,
        localId: message.localId,
        createdAt: message.createdAt,
        invokedAt: message.invokedAt,
        text: message.content.text,
        attachments: message.content.attachments,
        status: message.status,
        originalText: message.originalText,
        meta: message.meta
    })
}

export function decryptedMessageToOutlineItem(message: DecryptedMessage): ConversationOutlineItem | null {
    const normalized = normalizeDecryptedMessage(message)
    if (!normalized) {
        return null
    }
    return normalizedMessageToOutlineItem(normalized)
}

export function mergeConversationOutlineItems(
    existing: readonly ConversationOutlineItem[],
    incoming: readonly ConversationOutlineItem[]
): ConversationOutlineItem[] {
    if (incoming.length === 0) {
        return [...existing]
    }

    const merged = new Map<string, ConversationOutlineItem>()
    for (const item of existing) {
        merged.set(item.targetMessageId, item)
    }
    for (const item of incoming) {
        if (!merged.has(item.targetMessageId)) {
            merged.set(item.targetMessageId, item)
        }
    }

    return [...merged.values()].sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
            return left.createdAt - right.createdAt
        }
        return left.id.localeCompare(right.id)
    })
}

export function buildConversationOutline(blocks: readonly ChatBlock[]): ConversationOutlineItem[] {
    const items: ConversationOutlineItem[] = []

    for (const block of blocks) {
        if (block.kind === 'user-text') {
            items.push(userBlockToOutlineItem(block))
        }
    }

    return items
}

export function getConversationMessageAnchorId(messageId: string): string {
    return `hapi-message-${messageId}`
}
