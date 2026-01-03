import type { AgentEvent, ChatBlock, NormalizedMessage } from '@/chat/types'

function parseClaudeUsageLimit(text: string): number | null {
    const match = text.match(/^Claude AI usage limit reached\|(\d+)$/)
    if (!match) return null
    const timestamp = Number.parseInt(match[1], 10)
    if (!Number.isFinite(timestamp)) return null
    return timestamp
}

export function parseMessageAsEvent(msg: NormalizedMessage): AgentEvent | null {
    if (msg.isSidechain) return null
    if (msg.role !== 'agent') return null

    for (const content of msg.content) {
        if (content.type === 'text') {
            const limitReached = parseClaudeUsageLimit(content.text)
            if (limitReached !== null) {
                return { type: 'limit-reached', endsAt: limitReached }
            }
        }
    }

    return null
}

export function dedupeAgentEvents(blocks: ChatBlock[]): ChatBlock[] {
    const result: ChatBlock[] = []
    let prevEventKey: string | null = null
    let prevTitleChangedTo: string | null = null

    for (const block of blocks) {
        if (block.kind !== 'agent-event') {
            result.push(block)
            prevEventKey = null
            prevTitleChangedTo = null
            continue
        }

        const event = block.event as { type: string; [key: string]: unknown }
        if (event.type === 'title-changed' && typeof event.title === 'string') {
            const title = event.title.trim()
            const key = `title-changed:${title}`
            if (key === prevEventKey) {
                continue
            }
            result.push(block)
            prevEventKey = key
            prevTitleChangedTo = title
            continue
        }

        if (event.type === 'message' && typeof event.message === 'string') {
            const message = event.message.trim()
            const key = `message:${message}`
            if (key === prevEventKey) {
                continue
            }
            if (prevTitleChangedTo && message === prevTitleChangedTo) {
                continue
            }
            result.push(block)
            prevEventKey = key
            prevTitleChangedTo = null
            continue
        }

        let key: string
        try {
            key = `event:${JSON.stringify(event)}`
        } catch {
            key = `event:${String(event.type)}`
        }

        if (key === prevEventKey) {
            continue
        }

        result.push(block)
        prevEventKey = key
        prevTitleChangedTo = null
    }

    return result
}
