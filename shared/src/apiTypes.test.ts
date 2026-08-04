import { describe, expect, it } from 'vitest'
import {
    ClearOpencodeSessionCallbackRequestSchema,
    ClearOpencodeSessionResponseSchema,
    ListCodexSessionsRpcResponseSchema,
    ListPiSessionsRpcResponseSchema,
    MessagesQuerySchema,
    SendMessageRequestSchema
} from './apiTypes'

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

describe('ListPiSessionsRpcResponseSchema', () => {
    it('preserves stable Pi entry and local ids', () => {
        const parsed = ListPiSessionsRpcResponseSchema.parse({
            success: true,
            sessions: [{
                id: 'pi-session-id',
                title: 'Pi Session',
                file: '/home/user/.pi/agent/sessions/session.jsonl',
                modifiedAt: 1_000,
                messageCount: 1,
                activeEntryIds: ['entry-1'],
                messages: [{
                    localId: 'pi:pi-session-id:entry-1:user',
                    entryId: 'entry-1',
                    parentEntryId: null,
                    createdAt: 900,
                    content: {
                        role: 'user',
                        content: { type: 'text', text: 'hello' },
                        meta: { sentFrom: 'cli' }
                    }
                }]
            }]
        })

        expect(parsed.success).toBe(true)
        if (parsed.success) expect(parsed.sessions[0]?.messages?.[0]?.entryId).toBe('entry-1')
    })
})

describe('ClearOpencodeSessionResponseSchema', () => {
    it('requires the new HAPI session identity', () => {
        expect(ClearOpencodeSessionResponseSchema.parse({ ok: true, sessionId: 'fresh-session' })).toEqual({
            ok: true,
            sessionId: 'fresh-session'
        })
    })
})

describe('ClearOpencodeSessionCallbackRequestSchema', () => {
    it('requires the reservation identity', () => {
        expect(ClearOpencodeSessionCallbackRequestSchema.parse({ replacementSessionId: 'fresh-session' })).toEqual({
            replacementSessionId: 'fresh-session'
        })
        expect(ClearOpencodeSessionCallbackRequestSchema.safeParse({}).success).toBe(false)
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

describe('SendMessageRequestSchema deliveryMode', () => {
    it('accepts queue and steer delivery modes while leaving the field optional', () => {
        expect(SendMessageRequestSchema.parse({ text: 'queue' }).deliveryMode).toBeUndefined()
        expect(SendMessageRequestSchema.parse({ text: 'steer', deliveryMode: 'steer' }).deliveryMode).toBe('steer')
        expect(SendMessageRequestSchema.parse({ text: 'queue', deliveryMode: 'queue' }).deliveryMode).toBe('queue')
    })

    it('rejects scheduled steer delivery', () => {
        const parsed = SendMessageRequestSchema.safeParse({
            text: 'later',
            localId: 'scheduled-steer',
            scheduledAt: Date.now() + 60_000,
            deliveryMode: 'steer'
        })

        expect(parsed.success).toBe(false)
        if (!parsed.success) {
            expect(parsed.error.issues.some((issue) => issue.path[0] === 'deliveryMode')).toBe(true)
            expect(parsed.error.issues.some((issue) => issue.message.includes('cannot use steer'))).toBe(true)
        }
    })
})
