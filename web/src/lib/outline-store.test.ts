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

    it('does not include queued user messages in outline state', async () => {
        const api = makeApi([
            {
                messages: [{
                    ...makeUserMessage('queued', 'Queued item', 100),
                    invokedAt: null,
                    status: 'queued',
                }],
                page: {
                    nextBeforeAt: null,
                    nextBeforeSeq: null,
                    hasMore: false,
                },
            },
        ])

        await hydrateConversationOutline(api, SESSION_ID)
        ingestConversationOutlineMessage(SESSION_ID, {
            ...makeUserMessage('queued-live', 'Queued live item', 120),
            invokedAt: null,
            status: 'queued',
        })

        const state = getConversationOutlineState(SESSION_ID)
        expect(state.items).toEqual([])
    })

    it('ignores stale hydrate failures after reset and retry', async () => {
        let rejectFirstPage: ((reason?: unknown) => void) | null = null

        const api = {
            getMessages: vi
                .fn()
                .mockImplementationOnce(async () => await new Promise<never>((_resolve, reject) => {
                    rejectFirstPage = reject
                }))
                .mockResolvedValueOnce({
                    messages: [makeUserMessage('fresh', 'Fresh item', 300)],
                    page: {
                        limit: 50,
                        nextBeforeAt: null,
                        nextBeforeSeq: null,
                        hasMore: false,
                    },
                }),
        } as unknown as ApiClient

        const staleHydrate = hydrateConversationOutline(api, SESSION_ID)
        resetConversationOutline(SESSION_ID)
        await hydrateConversationOutline(api, SESSION_ID)

        expect(getConversationOutlineState(SESSION_ID)).toMatchObject({
            status: 'ready',
            complete: true,
            error: null,
        })

        const rejectStaleHydrate = rejectFirstPage
        if (!rejectStaleHydrate) {
            throw new Error('Expected stale hydrate request to be pending')
        }
        ;(rejectStaleHydrate as (reason?: unknown) => void)(new Error('stale failure'))
        await staleHydrate

        const state = getConversationOutlineState(SESSION_ID)
        expect(state).toMatchObject({
            status: 'ready',
            complete: true,
            error: null,
        })
        expect(state.items.map((item) => item.targetMessageId)).toEqual(['user:fresh'])
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
