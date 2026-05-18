import { describe, expect, it } from 'vitest'
import { formatMessage, formatNewMessages } from './contextFormatters'
import type { DecryptedMessage } from '@/types/api'

function makeMessage(content: unknown, seq = 1): DecryptedMessage {
    return {
        id: `msg-${seq}`,
        seq,
        localId: null,
        content,
        createdAt: 1_742_372_800_000
    }
}

describe('voice context formatters', () => {
    it('formats Codex assistant messages for realtime voice context', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: 'Finished the requested change.'
                }
            }
        })

        expect(formatMessage(message)).toContain('Finished the requested change.')
    })

    it('includes Codex assistant messages in new message batches', () => {
        const formatted = formatNewMessages('session-1', [
            makeMessage({
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        message: 'The tests pass now.'
                    }
                }
            })
        ])

        expect(formatted).toContain('New messages in session: session-1')
        expect(formatted).toContain('The tests pass now.')
    })

    it('formats Codex tool calls consistently with Claude tool calls', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    name: 'apply_patch',
                    input: { file: 'app.ts' }
                }
            }
        })

        expect(formatMessage(message)).toContain('Claude Code is using apply_patch')
    })
})
