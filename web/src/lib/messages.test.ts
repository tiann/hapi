import { describe, expect, it } from 'vitest'
import type { DecryptedMessage, MessageStatus } from '@/types/api'
import { mergeMessages } from './messages'

function userMessage(options: {
    id: string
    localId: string | null
    createdAt: number
    seq: number | null
    status?: MessageStatus
}): DecryptedMessage {
    return {
        ...options,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text: options.id,
            },
        },
    } as DecryptedMessage
}

describe('mergeMessages optimistic reconciliation', () => {
    it('orders a sequence-less optimistic send after persisted history despite client clock skew', () => {
        const stored = userMessage({
            id: 'stored-a',
            localId: null,
            createdAt: 1_000,
            seq: 1,
        })
        const optimistic = userMessage({
            id: 'local-a',
            localId: 'local-a',
            createdAt: 0,
            seq: null,
            status: 'sending',
        })

        expect(mergeMessages([stored], [optimistic]).map((message) => message.id)).toEqual([
            'stored-a',
            'local-a',
        ])
    })

    it('preserves an unrelated sent optimistic row when another localId is persisted nearby', () => {
        const optimisticA = userMessage({
            id: 'local-a',
            localId: 'local-a',
            createdAt: 1_000,
            seq: null,
            status: 'sent',
        })
        const optimisticB = userMessage({
            id: 'local-b',
            localId: 'local-b',
            createdAt: 1_001,
            seq: null,
            status: 'sent',
        })
        const storedA = userMessage({
            id: 'stored-a',
            localId: 'local-a',
            createdAt: 1_000,
            seq: 1,
        })

        expect(mergeMessages([storedA], [optimisticA, optimisticB]).map((message) => message.id)).toEqual([
            'stored-a',
            'local-b',
        ])
    })

    it.each([
        ['incoming-only operand', [], 'incoming'] as const,
        ['existing then incoming', ['optimistic'], 'stored'] as const,
        ['incoming then existing', ['stored'], 'optimistic'] as const,
    ])('reconciles a persisted localId echo for %s', (_name, existingOrder, incomingKind) => {
        const optimistic = userMessage({
            id: 'local-a',
            localId: 'local-a',
            createdAt: 1_000,
            seq: null,
            status: 'sent',
        })
        const stored = userMessage({
            id: 'stored-a',
            localId: 'local-a',
            createdAt: 1_000,
            seq: 1,
        })
        const existing = existingOrder.length === 0
            ? []
            : existingOrder[0] === 'optimistic'
                ? [optimistic]
                : [stored]
        const incoming = existingOrder.length === 0
            ? [optimistic, stored]
            : incomingKind === 'stored'
                ? [stored]
                : [optimistic]

        expect(mergeMessages(existing, incoming).map((message) => message.id)).toEqual(['stored-a'])
    })
})
