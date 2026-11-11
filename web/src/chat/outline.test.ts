import { describe, expect, it } from 'vitest'
import type { AgentEvent, ChatBlock } from '@/chat/types'
import {
    buildConversationOutline,
    findConversationMessageAnchor,
    findConversationMessageTextRange,
    truncateOutlineLabel
} from '@/chat/outline'

function userBlock(
    id: string,
    text: string,
    createdAt: number,
    overrides: Partial<Extract<ChatBlock, { kind: 'user-text' }>> = {}
): ChatBlock {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt,
        text,
        ...overrides
    }
}

function eventBlock(id: string, event: AgentEvent, createdAt: number): ChatBlock {
    return {
        kind: 'agent-event',
        id,
        createdAt,
        event,
    }
}

describe('conversation outline', () => {
    it('creates outline items from user messages', () => {
        expect(buildConversationOutline([
            userBlock('m1', 'Implement the outline panel', 1000),
        ])).toEqual([
            {
                id: 'outline:user-text:m1',
                targetMessageId: 'user-text:m1',
                kind: 'user',
                label: 'Implement the outline panel',
                createdAt: 1000
            }
        ])
    })

    it('ignores title and summary events', () => {
        const items = buildConversationOutline([
            eventBlock('e1', { type: 'title-changed', title: 'Add conversation outline' }, 1000),
            eventBlock('e2', { type: 'message', message: 'Context compacted into a summary.' }, 2000),
            eventBlock('e3', { type: 'ready' }, 3000),
        ])

        expect(items).toEqual([])
    })

    it('handles empty and long labels', () => {
        expect(buildConversationOutline([
            userBlock('empty', ' \n\t ', 1000),
        ])[0]?.label).toBe('Empty message')

        expect(truncateOutlineLabel('a '.repeat(80), 20)).toBe('a a a a a a a a a...')
    })

    it('filters queued user messages that are not yet locatable in the thread', () => {
        const items = buildConversationOutline([
            userBlock('queued', 'Queued prompt', 1000, { status: 'queued', invokedAt: null }),
            userBlock('sent', 'Visible prompt', 2000, { status: 'sent', invokedAt: 2500 }),
        ])

        expect(items.map((item) => item.id)).toEqual([
            'outline:user-text:sent'
        ])
    })

    it('keeps block order stable', () => {
        const items = buildConversationOutline([
            userBlock('first', 'First', 1000),
            eventBlock('summary', { type: 'message', message: 'Summary' }, 900),
            userBlock('second', 'Second', 1100),
        ])

        expect(items.map((item) => item.id)).toEqual([
            'outline:user-text:first',
            'outline:user-text:second'
        ])
    })

    it('finds rendered block anchors for raw HAPI message ids', () => {
        const direct = document.createElement('div')
        direct.id = 'hapi-message-user-text:direct'
        const rendered = document.createElement('div')
        rendered.id = 'hapi-message-agent-text:raw-message:0'
        const joined = document.createElement('div')
        joined.id = 'hapi-message-tool-call:tool-1'
        joined.setAttribute('data-hapi-source-message-ids', 'tool-source raw-message-2')
        const fragment = document.createElement('div')
        fragment.setAttribute('data-hapi-source-message-id', 'raw-message-3')
        joined.append(fragment)
        document.body.append(direct, rendered, joined)

        expect(findConversationMessageAnchor('direct')).toBe(direct)
        expect(findConversationMessageAnchor('raw-message')).toBe(rendered)
        expect(findConversationMessageAnchor('raw-message-2')).toBe(joined)
        expect(findConversationMessageAnchor('raw-message-3')).toBe(fragment)

        direct.remove()
        rendered.remove()
        joined.remove()
    })

    it('anchors a terminal-row hit to its own part when two streams share a phrase', () => {
        // Each stream kept a live and a terminal row, so the part exposes the
        // live id singly but carries both. A hit on the later stream's
        // terminal row must land on that part, not on the group marker (which
        // would select the first occurrence in the whole reply).
        const group = document.createElement('div')
        group.setAttribute('data-hapi-source-message-ids', 'live-1 terminal-1 live-2 terminal-2')

        const firstPart = document.createElement('div')
        firstPart.setAttribute('data-hapi-source-message-id', 'live-1')
        firstPart.setAttribute('data-hapi-source-part-message-ids', 'live-1 terminal-1')
        firstPart.textContent = 'The shared phrase appears here first'

        const secondPart = document.createElement('div')
        secondPart.setAttribute('data-hapi-source-message-id', 'live-2')
        secondPart.setAttribute('data-hapi-source-part-message-ids', 'live-2 terminal-2')
        secondPart.textContent = 'The shared phrase appears here again'

        group.append(firstPart, secondPart)
        document.body.append(group)

        expect(findConversationMessageAnchor('terminal-2')).toBe(secondPart)
        expect(findConversationMessageAnchor('terminal-2', 'shared phrase')).toBe(secondPart)
        expect(findConversationMessageAnchor('terminal-1', 'shared phrase')).toBe(firstPart)
        // Group-wide ids still resolve for callers with no per-part marker.
        expect(findConversationMessageAnchor('live-1')).toBe(firstPart)

        group.remove()
    })

    it('selects the rendered block containing the search query when a message is split', () => {
        const first = document.createElement('div')
        first.setAttribute('data-hapi-source-message-id', 'raw-message')
        first.textContent = 'Earlier block'
        const second = document.createElement('div')
        second.setAttribute('data-hapi-source-message-id', 'raw-message')
        second.textContent = 'The matching phrase is here'
        document.body.append(first, second)

        expect(findConversationMessageAnchor('raw-message')).toBe(first)
        expect(findConversationMessageAnchor('raw-message', 'matching phrase')).toBe(second)

        first.remove()
        second.remove()
    })

    it('finds a normalized search phrase across rendered text nodes', () => {
        const anchor = document.createElement('div')
        anchor.append('KV ', document.createElement('strong'))
        anchor.querySelector('strong')!.textContent = 'Cache'
        anchor.append(' is reusable')
        document.body.append(anchor)

        const range = findConversationMessageTextRange(anchor, '  kv   cache ')

        expect(range).not.toBeNull()
        expect(range!.toString()).toBe('KV Cache')
        anchor.remove()
    })

    it('keeps highlights aligned after whitespace collapse and case folding', () => {
        const anchor = document.createElement('div')
        anchor.textContent = 'Use   İSTANBUL'
        document.body.append(anchor)

        const range = findConversationMessageTextRange(anchor, 'use i\u0307stanbul')

        expect(range).not.toBeNull()
        expect(range!.toString()).toBe('Use   İSTANBUL')
        anchor.remove()
    })
})
