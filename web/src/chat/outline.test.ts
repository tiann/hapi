import { describe, expect, it } from 'vitest'
import type { AgentEvent, ChatBlock, NormalizedMessage } from '@/chat/types'
import type { DecryptedMessage } from '@/types/api'
import {
    buildConversationOutline,
    decryptedMessageToOutlineItem,
    mergeConversationOutlineItems,
    normalizedMessageToOutlineItem,
    truncateOutlineLabel
} from '@/chat/outline'

function userBlock(id: string, text: string, createdAt: number): ChatBlock {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt,
        text
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
                id: 'outline:user:m1',
                targetMessageId: 'user:m1',
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

    it('keeps block order stable', () => {
        const items = buildConversationOutline([
            userBlock('first', 'First', 1000),
            eventBlock('summary', { type: 'message', message: 'Summary' }, 900),
            userBlock('second', 'Second', 1100),
        ])

        expect(items.map((item) => item.id)).toEqual([
            'outline:user:first',
            'outline:user:second'
        ])
    })

    it('builds outline items from normalized user messages', () => {
        const normalized: NormalizedMessage = {
            id: 'm1',
            localId: null,
            createdAt: 123,
            role: 'user',
            isSidechain: false,
            content: {
                type: 'text',
                text: 'Outline me'
            }
        }

        expect(normalizedMessageToOutlineItem(normalized)).toEqual({
            id: 'outline:user:m1',
            targetMessageId: 'user:m1',
            kind: 'user',
            label: 'Outline me',
            createdAt: 123
        })
    })

    it('ignores non-user normalized messages', () => {
        const normalized: NormalizedMessage = {
            id: 'a1',
            localId: null,
            createdAt: 123,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'text',
                text: 'Ignore me',
                uuid: 'a1',
                parentUUID: null
            }]
        }

        expect(normalizedMessageToOutlineItem(normalized)).toBeNull()
    })

    it('builds outline items from decrypted user messages', () => {
        const message: DecryptedMessage = {
            id: 'server-1',
            seq: 1,
            localId: null,
            createdAt: 456,
            invokedAt: null,
            content: {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'Hydrated outline'
                }
            }
        }

        expect(decryptedMessageToOutlineItem(message)).toEqual({
            id: 'outline:user:server-1',
            targetMessageId: 'user:server-1',
            kind: 'user',
            label: 'Hydrated outline',
            createdAt: 456
        })
    })

    it('merges outline items without duplicates and keeps chronological order', () => {
        const merged = mergeConversationOutlineItems([
            {
                id: 'outline:user:newer',
                targetMessageId: 'user:newer',
                kind: 'user',
                label: 'Newer',
                createdAt: 200
            }
        ], [
            {
                id: 'outline:user:older',
                targetMessageId: 'user:older',
                kind: 'user',
                label: 'Older',
                createdAt: 100
            },
            {
                id: 'outline:user:newer-duplicate',
                targetMessageId: 'user:newer',
                kind: 'user',
                label: 'Duplicate',
                createdAt: 200
            }
        ])

        expect(merged.map((item) => item.targetMessageId)).toEqual([
            'user:older',
            'user:newer'
        ])
    })
})
