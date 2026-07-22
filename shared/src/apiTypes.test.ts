import { describe, expect, it } from 'vitest'
import { ListCodexSessionsRpcResponseSchema } from './apiTypes'

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
