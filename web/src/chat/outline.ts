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
        id: `outline:user-text:${block.id}`,
        targetMessageId: `user-text:${block.id}`,
        kind: 'user',
        label,
        createdAt: block.createdAt
    }
}

function isLocatableOutlineBlock(block: ChatBlock): block is UserTextBlock {
    return block.kind === 'user-text'
        && !(block.invokedAt === null && block.status !== 'failed')
}

export function buildConversationOutline(blocks: readonly ChatBlock[]): ConversationOutlineItem[] {
    const items: ConversationOutlineItem[] = []

    for (const block of blocks) {
        if (isLocatableOutlineBlock(block)) {
            items.push(userBlockToOutlineItem(block))
        }
    }

    return items
}

export function getConversationMessageAnchorId(messageId: string): string {
    return `hapi-message-${messageId}`
}

/**
 * Find a case-insensitive, whitespace-normalized query within one rendered
 * message part. The returned range can cross Markdown text nodes, so callers
 * can scroll to the actual matching phrase instead of centering a long card.
 */
export function findConversationMessageTextRange(anchor: HTMLElement, query: string): Range | null {
    const normalizedQuery = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
    if (!normalizedQuery) return null

    const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT)
    const positions: Array<{ node: Text; offset: number }> = []
    let normalizedText = ''
    let current: Node | null
    while ((current = walker.nextNode())) {
        const node = current as Text
        for (let offset = 0; offset < node.data.length; offset += 1) {
            const character = node.data[offset]!
            if (/\s/.test(character)) {
                if (normalizedText.endsWith(' ')) continue
                normalizedText += ' '
            } else {
                normalizedText += character.toLocaleLowerCase()
            }
            positions.push({ node, offset })
        }
    }

    const matchAt = normalizedText.indexOf(normalizedQuery)
    if (matchAt < 0) return null
    const start = positions[matchAt]
    const end = positions[matchAt + normalizedQuery.length - 1]
    if (!start || !end) return null

    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset + 1)
    return range
}

/**
 * Resolve an anchor for either a rendered assistant-ui message id or a raw
 * HAPI message id. Assistant blocks append their source id after the block
 * kind (for example, `agent-text:<message-id>:0`), so a raw search result
 * does not always have the exact DOM id returned by getConversationMessageAnchorId.
 */
function getConversationMessageCandidates(messageId: string): HTMLElement[] {
    const candidates: HTMLElement[] = []
    const seen = new Set<HTMLElement>()
    const add = (element: HTMLElement | null) => {
        if (!element || seen.has(element)) return
        seen.add(element)
        candidates.push(element)
    }

    for (const element of document.querySelectorAll<HTMLElement>('[data-hapi-source-message-id]')) {
        if (element.getAttribute('data-hapi-source-message-id') === messageId) add(element)
    }

    add(document.getElementById(getConversationMessageAnchorId(messageId)))

    for (const element of document.querySelectorAll<HTMLElement>('[data-hapi-source-message-ids]')) {
        const sourceIds = element.getAttribute('data-hapi-source-message-ids')?.split(/\s+/) ?? []
        if (sourceIds.includes(messageId)) add(element)
    }

    const sourceMarker = `:${messageId}`
    for (const element of document.querySelectorAll<HTMLElement>('[id]')) {
        const candidate = element.id
        if (
            candidate.startsWith('hapi-message-')
            && (
                candidate.endsWith(sourceMarker)
                || candidate.includes(`${sourceMarker}:`)
            )
        ) {
            add(element)
        }
    }

    return candidates
}

export function findConversationMessageAnchor(messageId: string, query?: string): HTMLElement | null {
    const candidates = getConversationMessageCandidates(messageId)
    if (query) {
        const matching = candidates.find((element) => findConversationMessageTextRange(element, query) !== null)
        if (matching) return matching
    }
    return candidates[0] ?? null
}
