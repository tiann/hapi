import type { ChatBlock, UserTextBlock } from '@/chat/types'

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

function userBlockToOutlineItem(block: UserTextBlock): ConversationOutlineItem {
    const label = truncateOutlineLabel(block.text) || 'Empty message'
    return {
        id: `outline:user:${block.id}`,
        targetMessageId: `user:${block.id}`,
        kind: 'user',
        label,
        createdAt: block.createdAt
    }
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
