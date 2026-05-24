import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { extractLastAssistantSpeakable, formatMessage, formatNewMessages, formatReadyEvent } from './contextFormatters'

function msg(partial: Pick<DecryptedMessage, 'id' | 'seq' | 'content'>): DecryptedMessage {
    return {
        id: partial.id,
        seq: partial.seq,
        localId: null,
        content: partial.content,
        createdAt: 0,
        sessionId: 'session-1'
    } as DecryptedMessage
}

describe('extractLastAssistantSpeakable', () => {
    it('returns null for empty history', () => {
        expect(extractLastAssistantSpeakable([])).toBeNull()
    })

    it('returns the latest assistant plain string', () => {
        const messages = [
            msg({ id: '1', seq: 1, content: { role: 'user', content: 'hello' } }),
            msg({ id: '2', seq: 2, content: { role: 'assistant', content: 'first reply' } }),
            msg({ id: '3', seq: 3, content: { role: 'assistant', content: '  latest reply  ' } })
        ]
        expect(extractLastAssistantSpeakable(messages)).toBe('latest reply')
    })

    it('skips trailing user messages and reads earlier assistant text', () => {
        const messages = [
            msg({ id: '1', seq: 1, content: { role: 'assistant', content: 'done with subtitle search' } }),
            msg({ id: '2', seq: 2, content: { role: 'user', content: 'thanks' } })
        ]
        expect(extractLastAssistantSpeakable(messages)).toBe('done with subtitle search')
    })

    it('extracts text blocks from assistant content arrays', () => {
        const messages = [
            msg({
                id: '1',
                seq: 1,
                content: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Part one.' },
                        { type: 'text', text: 'Part two.' }
                    ]
                }
            })
        ]
        expect(extractLastAssistantSpeakable(messages)).toBe('Part one.\n\nPart two.')
    })

    it('extracts codex stream-json assistant messages', () => {
        const messages = [
            msg({
                id: '1',
                seq: 1,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            message: '**Subtitle coverage** — 5,018 indexed items.'
                        }
                    }
                }
            }),
            msg({
                id: '2',
                seq: 2,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: { type: 'ready' }
                    }
                }
            })
        ]
        expect(extractLastAssistantSpeakable(messages)).toBe('**Subtitle coverage** — 5,018 indexed items.')
    })

    it('unwraps codex-style output envelopes', () => {
        const messages = [
            msg({
                id: '1',
                seq: 1,
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: { content: 'Codex finished the refactor.' }
                    }
                }
            })
        ]
        expect(extractLastAssistantSpeakable(messages)).toBe('Codex finished the refactor.')
    })
})

describe('formatReadyEvent', () => {
    const sessionId = '9d04335d-2b90-4941-98a7-eb414823f0e0'

    it('embeds assistant text when provided', () => {
        const text = 'Added subtitle index search to jellybot.'
        const event = formatReadyEvent(sessionId, text)
        expect(event).toContain('coding agent finished working')
        expect(event).toContain(`<text>${text}</text>`)
        expect(event).not.toContain('Claude Code')
    })

    it('falls back when assistant text is missing', () => {
        const event = formatReadyEvent(sessionId, null)
        expect(event).toContain('Use the latest agent message already present in context')
        expect(event).not.toContain('Claude Code')
    })

    it('treats blank assistant text as missing', () => {
        const event = formatReadyEvent(sessionId, '   ')
        expect(event).toContain('Use the latest agent message already present in context')
    })
})

describe('formatMessage', () => {
    it('formats codex stream-json assistant messages for voice context', () => {
        const formatted = formatMessage(msg({
            id: '1',
            seq: 1,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        message: '**Subtitle coverage** — 5,018 indexed items.'
                    }
                }
            }
        }))

        expect(formatted).toContain('Claude Code:')
        expect(formatted).toContain('<text>**Subtitle coverage** — 5,018 indexed items.</text>')
    })

    it('ignores codex ready and tool-call payloads', () => {
        expect(formatMessage(msg({
            id: '1',
            seq: 1,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: { type: 'ready' }
                }
            }
        }))).toBeNull()
    })
})

describe('formatNewMessages', () => {
    it('includes codex assistant replies in contextual updates', () => {
        const update = formatNewMessages('session-1', [
            msg({
                id: '1',
                seq: 1,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            message: 'Database size is 2.43 GiB.'
                        }
                    }
                }
            })
        ])

        expect(update).toContain('New messages in session: session-1')
        expect(update).toContain('Database size is 2.43 GiB.')
    })
})
