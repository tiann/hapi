import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    getConversationOutlineState,
    hydrateConversationOutline,
    ingestConversationOutlineMessage,
    resetConversationOutline,
    seedConversationOutline,
    setConversationOutlineLocating,
} from '@/lib/outline-store'

function makeUserMessage(id: string, text: string, createdAt: number): DecryptedMessage {
    return {
        id,
        seq: createdAt,
        localId: null,
        createdAt,
        invokedAt: createdAt,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text,
            },
        },
    }
}

function makeApi(pages: Array<{
    messages: DecryptedMessage[]
    page: {
        nextBeforeAt: number | null
        nextBeforeSeq: number | null
        hasMore: boolean
        limit?: number
    }
}>): ApiClient {
    return {
        getMessages: vi.fn(async (_sessionId: string, options: { limit?: number }) => {
            const next = pages.shift()
            if (!next) {
                throw new Error('No page configured')
            }
            return {
                messages: next.messages,
                page: {
                    limit: options.limit ?? 50,
                    nextBeforeAt: next.page.nextBeforeAt,
                    nextBeforeSeq: next.page.nextBeforeSeq,
                    hasMore: next.page.hasMore,
                },
            }
        }),
    } as unknown as ApiClient
}

describe('outline-store', () => {
    const SESSION_ID = 'outline-store-session'

    afterEach(() => {
        resetConversationOutline(SESSION_ID)
    })

    it('hydrates across pages and keeps chronological order', async () => {
        const api = makeApi([
            {
                messages: [
                    makeUserMessage('newer', 'Newer item', 200),
                ],
                page: {
                    nextBeforeAt: 200,
                    nextBeforeSeq: 200,
                    hasMore: true,
                },
            },
            {
                messages: [
                    makeUserMessage('older', 'Older item', 100),
                ],
                page: {
                    nextBeforeAt: null,
                    nextBeforeSeq: null,
                    hasMore: false,
                },
            },
        ])

        await hydrateConversationOutline(api, SESSION_ID)

        const state = getConversationOutlineState(SESSION_ID)
        expect(state.complete).toBe(true)
        expect(state.items.map((item) => item.targetMessageId)).toEqual([
            'user:older',
            'user:newer',
        ])
    })

    it('deduplicates seeded and hydrated items', async () => {
        seedConversationOutline(SESSION_ID, [{
            id: 'outline:user:newer',
            targetMessageId: 'user:newer',
            kind: 'user',
            label: 'Newer item',
            createdAt: 200,
        }])

        const api = makeApi([
            {
                messages: [
                    makeUserMessage('newer', 'Newer item', 200),
                    makeUserMessage('older', 'Older item', 100),
                ],
                page: {
                    nextBeforeAt: null,
                    nextBeforeSeq: null,
                    hasMore: false,
                },
            },
        ])

        await hydrateConversationOutline(api, SESSION_ID)

        const state = getConversationOutlineState(SESSION_ID)
        expect(state.items.map((item) => item.targetMessageId)).toEqual([
            'user:older',
            'user:newer',
        ])
    })

    it('ingests new user messages after completion', async () => {
        const api = makeApi([
            {
                messages: [makeUserMessage('baseline', 'Baseline', 100)],
                page: {
                    nextBeforeAt: null,
                    nextBeforeSeq: null,
                    hasMore: false,
                },
            },
        ])

        await hydrateConversationOutline(api, SESSION_ID)
        ingestConversationOutlineMessage(SESSION_ID, makeUserMessage('new', 'New item', 300))

        const state = getConversationOutlineState(SESSION_ID)
        expect(state.complete).toBe(true)
        expect(state.items.map((item) => item.targetMessageId)).toEqual([
            'user:baseline',
            'user:new',
        ])
    })

    it('tracks locating state and errors', () => {
        setConversationOutlineLocating(SESSION_ID, 'user:target')
        expect(getConversationOutlineState(SESSION_ID)).toMatchObject({
            isLocating: true,
            locatingTargetMessageId: 'user:target',
            locateError: null,
        })

        setConversationOutlineLocating(SESSION_ID, null, 'Unable to locate')
        expect(getConversationOutlineState(SESSION_ID)).toMatchObject({
            isLocating: false,
            locatingTargetMessageId: null,
            locateError: 'Unable to locate',
        })
    })
})
