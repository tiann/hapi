import { describe, expect, it } from 'vitest'
import { ListCodexSessionsRpcResponseSchema, MessagesQuerySchema } from './apiTypes'

describe('ListCodexSessionsRpcResponseSchema', () => {
    it('preserves Codex session messages when parsing runner RPC responses', () => {
        const parsed = ListCodexSessionsRpcResponseSchema.parse({
            success: true,
            sessions: [{
                id: 'codex-session-id',
                title: 'Codex Session',
                file: '/home/user/.codex/sessions/session.jsonl',
                modifiedAt: 1_000,
                messages: [{
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'hello'
                    },
                    meta: {
                        sentFrom: 'cli'
                    }
                }]
            }]
        })

        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(parsed.sessions[0]?.messages).toHaveLength(1)
        }
    })
})

describe('MessagesQuerySchema', () => {
    it('parses a forward cursor with a bounded snapshot and epoch', () => {
        expect(MessagesQuerySchema.parse({
            afterAt: '1000',
            afterSeq: '10',
            untilAt: '2000',
            untilSeq: '20',
            epoch: '3',
            limit: '200'
        })).toEqual({
            afterAt: 1000,
            afterSeq: 10,
            untilAt: 2000,
            untilSeq: 20,
            epoch: 3,
            limit: 200
        })
    })

    it('rejects mixed before and after directions', () => {
        expect(MessagesQuerySchema.safeParse({
            beforeAt: 1000,
            beforeSeq: 10,
            afterAt: 2000,
            afterSeq: 20
        }).success).toBe(false)
    })

    it('rejects an unpaired or unscoped until cursor', () => {
        expect(MessagesQuerySchema.safeParse({ untilAt: 2000, untilSeq: 20 }).success).toBe(false)
        expect(MessagesQuerySchema.safeParse({ afterAt: 1000, afterSeq: 10, untilAt: 2000 }).success).toBe(false)
    })

    it('rejects epoch without a forward cursor', () => {
        expect(MessagesQuerySchema.safeParse({ epoch: 1 }).success).toBe(false)
    })
})
