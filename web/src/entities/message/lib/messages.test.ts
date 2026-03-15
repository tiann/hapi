import { describe, expect, it } from 'vitest'
import {
    makeClientSideId,
    isUserMessage,
    mergeMessages,
    upsertMessagesInCache,
} from './messages'
import type { DecryptedMessage } from '@/types/api'

describe('messages lib', () => {
    describe('makeClientSideId', () => {
        it('generates ID with crypto.randomUUID when available', () => {
            const id = makeClientSideId('test')
            expect(id).toMatch(/^test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
        })

        it('includes the prefix in the ID', () => {
            const id = makeClientSideId('msg')
            expect(id).toMatch(/^msg-/)
        })
    })

    describe('isUserMessage', () => {
        it('returns true for user messages', () => {
            const msg: DecryptedMessage = {
                id: '1',
                content: { role: 'user', text: 'hello' },
                createdAt: Date.now(),
            } as DecryptedMessage
            expect(isUserMessage(msg)).toBe(true)
        })

        it('returns false for assistant messages', () => {
            const msg: DecryptedMessage = {
                id: '1',
                content: { role: 'assistant', text: 'hi' },
                createdAt: Date.now(),
            } as DecryptedMessage
            expect(isUserMessage(msg)).toBe(false)
        })

        it('returns false for messages without role', () => {
            const msg: DecryptedMessage = {
                id: '1',
                content: { text: 'hello' },
                createdAt: Date.now(),
            } as DecryptedMessage
            expect(isUserMessage(msg)).toBe(false)
        })

        it('returns false for null content', () => {
            const msg: DecryptedMessage = {
                id: '1',
                content: null,
                createdAt: Date.now(),
            } as DecryptedMessage
            expect(isUserMessage(msg)).toBe(false)
        })
    })

    describe('mergeMessages', () => {
        it('returns incoming messages when existing is empty', () => {
            const incoming: DecryptedMessage[] = [
                { id: '1', content: {}, createdAt: 1000 } as DecryptedMessage,
            ]
            const result = mergeMessages([], incoming)
            expect(result).toHaveLength(1)
            expect(result[0]?.id).toBe('1')
        })

        it('returns existing messages when incoming is empty', () => {
            const existing: DecryptedMessage[] = [
                { id: '1', content: {}, createdAt: 1000 } as DecryptedMessage,
            ]
            const result = mergeMessages(existing, [])
            expect(result).toHaveLength(1)
            expect(result[0]?.id).toBe('1')
        })

        it('merges messages by ID', () => {
            const existing: DecryptedMessage[] = [
                { id: '1', content: {}, createdAt: 1000 } as DecryptedMessage,
            ]
            const incoming: DecryptedMessage[] = [
                { id: '2', content: {}, createdAt: 2000 } as DecryptedMessage,
            ]
            const result = mergeMessages(existing, incoming)
            expect(result).toHaveLength(2)
        })

        it('sorts messages by seq number', () => {
            const existing: DecryptedMessage[] = [
                { id: '2', seq: 2, content: {}, createdAt: 2000 } as DecryptedMessage,
            ]
            const incoming: DecryptedMessage[] = [
                { id: '1', seq: 1, content: {}, createdAt: 1000 } as DecryptedMessage,
            ]
            const result = mergeMessages(existing, incoming)
            expect(result[0]?.id).toBe('1')
            expect(result[1]?.id).toBe('2')
        })

        it('removes optimistic messages when server message arrives with same localId', () => {
            const optimistic: DecryptedMessage = {
                id: 'local-123',
                localId: 'local-123',
                content: { role: 'user' },
                createdAt: 1000,
            } as DecryptedMessage

            const serverMsg: DecryptedMessage = {
                id: 'server-456',
                localId: 'local-123',
                content: { role: 'user' },
                createdAt: 1000,
            } as DecryptedMessage

            const result = mergeMessages([optimistic], [serverMsg])
            expect(result).toHaveLength(1)
            expect(result[0]?.id).toBe('server-456')
        })

        it('removes sent optimistic messages when server user message appears close in time', () => {
            const optimistic: DecryptedMessage = {
                id: 'local-123',
                localId: 'local-123',
                content: { role: 'user' },
                createdAt: 1000,
                status: 'sent',
            } as DecryptedMessage

            const serverMsg: DecryptedMessage = {
                id: 'server-456',
                content: { role: 'user' },
                createdAt: 1005,
            } as DecryptedMessage

            const result = mergeMessages([optimistic], [serverMsg])
            expect(result).toHaveLength(1)
            expect(result[0]?.id).toBe('server-456')
        })
    })

    describe('upsertMessagesInCache', () => {
        it('creates new cache when data is undefined', () => {
            const incoming: DecryptedMessage[] = [
                { id: '1', content: {}, createdAt: 1000 } as DecryptedMessage,
            ]
            const result = upsertMessagesInCache(undefined, incoming)
            expect(result.pages).toHaveLength(1)
            expect(result.pages[0]?.messages).toHaveLength(1)
        })

        it('merges incoming messages into first page', () => {
            const existing = {
                pages: [
                    {
                        messages: [
                            { id: '1', content: {}, createdAt: 1000 } as DecryptedMessage,
                        ],
                        page: {
                            limit: 50,
                            beforeSeq: null,
                            nextBeforeSeq: null,
                            hasMore: false,
                        },
                    },
                ],
                pageParams: [null],
            }
            const incoming: DecryptedMessage[] = [
                { id: '2', content: {}, createdAt: 2000 } as DecryptedMessage,
            ]
            const result = upsertMessagesInCache(existing, incoming)
            expect(result.pages[0]?.messages).toHaveLength(2)
        })
    })
})
