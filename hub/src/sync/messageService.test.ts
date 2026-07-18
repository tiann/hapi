import { describe, expect, it } from 'bun:test'
import type { StoredMessage } from '../store'
import { MessageService } from './messageService'

function createStoredMessage(seq: number, content: unknown = { role: 'assistant', content: { type: 'text', text: `message ${seq}` } }): StoredMessage {
    return {
        id: `message-${seq}`,
        sessionId: 'session-1',
        content,
        createdAt: seq,
        seq,
        localId: null,
    }
}

describe('MessageService getMessagesPage', () => {
    it('returns the complete directional page contract', () => {
        const messages = [
            createStoredMessage(7, { role: 'user', content: { type: 'text', text: 'question' } }),
            createStoredMessage(8),
            createStoredMessage(9),
        ]
        const store = {
            messages: {
                getMessages(_sessionId: string, limit: number, beforeSeq?: number) {
                    const eligible = beforeSeq === undefined
                        ? messages
                        : messages.filter((message) => message.seq < beforeSeq)
                    return eligible.slice(Math.max(0, eligible.length - limit))
                },
                getMessagesAfter(_sessionId: string, afterSeq: number, limit: number) {
                    return messages.filter((message) => message.seq > afterSeq).slice(0, limit)
                },
            },
        }
        const service = new MessageService(store as never, {} as never, {} as never)

        const page = service.getMessagesPage('session-1', {
            limit: 2,
            beforeSeq: 10,
            afterSeq: null,
        })

        expect(page.messages.map((message) => message.seq)).toEqual([7, 8, 9])
        expect(page.page).toEqual({
            limit: 2,
            direction: 'older',
            beforeSeq: 10,
            afterSeq: null,
            nextBeforeSeq: 7,
            nextAfterSeq: 9,
            hasMore: false,
            hasOlder: false,
            hasNewer: false,
            range: { startSeq: 7, endSeq: 9 },
            startComplete: true,
            endComplete: true,
            continuation: null,
        })
    })
})

describe('MessageService getRecentUserMessages', () => {
    it('scans older pages until it finds the requested recent user messages', () => {
        const newestAssistantPage = Array.from({ length: 200 }, (_, index) => (
            createStoredMessage(201 + index)
        ))
        const olderUserPage = [
            createStoredMessage(1, { role: 'user', content: { type: 'text', text: 'older prompt' } }),
            createStoredMessage(2, { role: 'user', content: { type: 'text', text: 'newer prompt' } })
        ]
        const calls: Array<{ sessionId: string; limit: number; beforeSeq?: number }> = []
        const store = {
            messages: {
                getMessages(sessionId: string, limit: number, beforeSeq?: number) {
                    calls.push({ sessionId, limit, beforeSeq })
                    return beforeSeq === undefined ? newestAssistantPage : olderUserPage
                },
            },
        }
        const service = new MessageService(store as never, {} as never, {} as never)

        const recent = service.getRecentUserMessages('session-1', { limit: 2 })

        expect(calls).toEqual([
            { sessionId: 'session-1', limit: 200, beforeSeq: undefined },
            { sessionId: 'session-1', limit: 200, beforeSeq: 201 }
        ])
        expect(recent.map((message) => message.text)).toEqual(['newer prompt', 'older prompt'])
    })

    it('filters empty text, codex pseudo-user artifacts, non-user messages, and duplicate prompts', () => {
        const store = {
            messages: {
                getMessages() {
                    return [
                        createStoredMessage(1, { role: 'user', content: { type: 'text', text: 'same prompt' } }),
                        createStoredMessage(2, { role: 'assistant', content: { type: 'text', text: 'not user' } }),
                        createStoredMessage(3, { role: 'user', content: { type: 'text', text: '   ' } }),
                        {
                            ...createStoredMessage(4, {
                                role: 'user',
                                content: { type: 'text', text: '<subagent_notification>skip</subagent_notification>' },
                                meta: { sentFrom: 'codex-desktop-sync' }
                            }),
                            localId: 'codex:thread:4'
                        },
                        createStoredMessage(5, { role: 'user', content: { type: 'text', text: 'same prompt' } }),
                        createStoredMessage(6, { role: 'user', content: { type: 'text', text: 'latest prompt', attachments: [{ id: 'a' }] } })
                    ]
                },
            },
        }
        const service = new MessageService(store as never, {} as never, {} as never)

        const recent = service.getRecentUserMessages('session-1', { limit: 10 })

        expect(recent.map((message) => ({
            seq: message.seq,
            text: message.text
        }))).toEqual([
            { seq: 6, text: 'latest prompt' },
            { seq: 5, text: 'same prompt' }
        ])
    })

    it('includes non-sidechain agent-output user text arrays and skips sidechain or mixed user output', () => {
        const store = {
            messages: {
                getMessages() {
                    return [
                        createStoredMessage(1, {
                            role: 'agent',
                            content: {
                                type: 'output',
                                data: {
                                    type: 'user',
                                    isSidechain: false,
                                    message: {
                                        content: [
                                            { type: 'text', text: 'first part' },
                                            { type: 'text', text: 'second part' }
                                        ]
                                    }
                                }
                            }
                        }),
                        createStoredMessage(2, {
                            role: 'agent',
                            content: {
                                type: 'output',
                                data: {
                                    type: 'user',
                                    isSidechain: true,
                                    message: {
                                        content: [
                                            { type: 'text', text: 'sidechain prompt' }
                                        ]
                                    }
                                }
                            }
                        }),
                        createStoredMessage(3, {
                            role: 'agent',
                            content: {
                                type: 'output',
                                data: {
                                    type: 'user',
                                    isSidechain: false,
                                    message: {
                                        content: [
                                            { type: 'text', text: 'mixed text' },
                                            { type: 'tool_result', tool_use_id: 'tool-1', content: 'tool output' }
                                        ]
                                    }
                                }
                            }
                        }),
                        createStoredMessage(4, {
                            role: 'agent',
                            content: {
                                type: 'output',
                                data: {
                                    type: 'user',
                                    isSidechain: false,
                                    message: {
                                        content: 'system-injected string user output'
                                    }
                                }
                            }
                        }),
                        createStoredMessage(5, {
                            role: 'agent',
                            content: {
                                type: 'output',
                                data: {
                                    type: 'user',
                                    isSidechain: false,
                                    message: {
                                        content: [
                                            { type: 'text', text: 'latest prompt' }
                                        ]
                                    }
                                }
                            }
                        })
                    ]
                },
            },
        }
        const service = new MessageService(store as never, {} as never, {} as never)

        const recent = service.getRecentUserMessages('session-1', { limit: 10 })

        expect(recent.map((message) => ({
            seq: message.seq,
            text: message.text
        }))).toEqual([
            { seq: 5, text: 'latest prompt' },
            { seq: 1, text: 'first part\n\nsecond part' }
        ])
    })
})
