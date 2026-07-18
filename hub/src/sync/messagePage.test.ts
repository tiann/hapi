import { describe, expect, it } from 'bun:test'
import type { StoredMessage } from '../store'
import { isLogicalTurnStart, readCompleteMessagePage } from './messagePage'

function storedMessage(seq: number, content: unknown, localId: string | null = null): StoredMessage {
    return {
        id: `message-${seq}`,
        sessionId: 'session-1',
        content,
        createdAt: seq,
        seq,
        localId,
    }
}

function createMemoryMessageStore(messages: StoredMessage[]) {
    return {
        getMessages(
            _sessionId: string,
            limit: number,
            beforeSeq?: number,
        ): StoredMessage[] {
            const eligible = beforeSeq === undefined
                ? messages
                : messages.filter((message) => message.seq < beforeSeq)
            return eligible.slice(Math.max(0, eligible.length - limit))
        },
        getMessagesAfter(
            _sessionId: string,
            afterSeq: number,
            limit: number,
        ): StoredMessage[] {
            return messages.filter((message) => message.seq > afterSeq).slice(0, limit)
        },
    }
}

describe('isLogicalTurnStart', () => {
    it('recognizes direct text and attachment-only user inputs', () => {
        expect(isLogicalTurnStart(storedMessage(1, {
            role: 'user',
            content: { type: 'text', text: 'question' },
        }))).toBe(true)

        expect(isLogicalTurnStart(storedMessage(2, {
            role: 'user',
            content: { type: 'text', text: '', attachments: [{ id: 'attachment-1' }] },
        }))).toBe(true)
    })

    it('recognizes only visible non-sidechain Claude user output', () => {
        expect(isLogicalTurnStart(storedMessage(3, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    isSidechain: false,
                    message: { content: [{ type: 'text', text: 'question' }] },
                },
            },
        }))).toBe(true)

        expect(isLogicalTurnStart(storedMessage(4, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    isSidechain: true,
                    message: { content: [{ type: 'text', text: 'sidechain prompt' }] },
                },
            },
        }))).toBe(false)

        expect(isLogicalTurnStart(storedMessage(5, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    isSidechain: false,
                    message: {
                        content: [
                            { type: 'text', text: 'not a real prompt boundary' },
                            { type: 'tool_result', tool_use_id: 'tool-1', content: 'tool output' },
                        ],
                    },
                },
            },
        }))).toBe(false)

        expect(isLogicalTurnStart(storedMessage(6, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    isSidechain: false,
                    message: { content: [{ type: 'text', text: '  \n\t' }] },
                },
            },
        }))).toBe(false)
    })

    it('rejects Codex desktop pseudo-user synchronization records', () => {
        expect(isLogicalTurnStart(storedMessage(7, {
            role: 'user',
            content: {
                type: 'text',
                text: '<subagent_notification>background update</subagent_notification>',
            },
            meta: { sentFrom: 'codex-desktop-sync' },
        }, 'codex:thread:7'))).toBe(false)

        expect(isLogicalTurnStart(storedMessage(8, {
            role: 'user',
            content: { type: 'text', text: '<turn_aborted>cancelled</turn_aborted>' },
            meta: { sentFrom: 'codex-desktop-sync' },
        }))).toBe(false)
    })
})

describe('readCompleteMessagePage', () => {
    it('extends a 50-row latest target to the start of a 1,000-pair logical turn', () => {
        const messages: StoredMessage[] = [storedMessage(1, {
            role: 'user',
            content: { type: 'text', text: 'stress question' },
        })]
        for (let index = 0; index < 1_000; index += 1) {
            const callSeq = index * 2 + 2
            messages.push(storedMessage(callSeq, {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: { type: 'tool-call', callId: `call-${index}`, name: 'Read', input: { index } },
                },
            }))
            messages.push(storedMessage(callSeq + 1, {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: { type: 'tool-call-result', callId: `call-${index}`, output: `result-${index}` },
                },
            }))
        }
        messages.push(storedMessage(2_002, {
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'message', message: 'stress final answer' },
            },
        }))

        const result = readCompleteMessagePage(
            createMemoryMessageStore(messages),
            'session-1',
            { limit: 50, beforeSeq: null, afterSeq: null },
        )

        expect(result.messages).toHaveLength(2_002)
        expect(result.messages[0]?.seq).toBe(1)
        expect(result.messages.at(-1)?.seq).toBe(2_002)
        expect(result.page).toEqual({
            limit: 50,
            direction: 'latest',
            beforeSeq: null,
            afterSeq: null,
            nextBeforeSeq: 1,
            nextAfterSeq: 2_002,
            hasMore: false,
            hasOlder: false,
            hasNewer: false,
            range: { startSeq: 1, endSeq: 2_002 },
            startComplete: true,
            endComplete: true,
            continuation: null,
        })
    })

    it('returns non-overlapping complete turns in both history directions', () => {
        const messages = [
            storedMessage(1, { role: 'user', content: { type: 'text', text: 'turn 1' } }),
            storedMessage(2, { role: 'agent', content: { type: 'text', text: 'turn 1 work' } }),
            storedMessage(3, { role: 'agent', content: { type: 'text', text: 'turn 1 answer' } }),
            storedMessage(4, { role: 'user', content: { type: 'text', text: 'turn 2' } }),
            storedMessage(5, { role: 'agent', content: { type: 'text', text: 'turn 2 work' } }),
            storedMessage(6, { role: 'agent', content: { type: 'text', text: 'turn 2 answer' } }),
            storedMessage(7, { role: 'user', content: { type: 'text', text: 'turn 3' } }),
            storedMessage(8, { role: 'agent', content: { type: 'text', text: 'turn 3 work' } }),
            storedMessage(9, { role: 'agent', content: { type: 'text', text: 'turn 3 answer' } }),
        ]
        const store = createMemoryMessageStore(messages)

        const older = readCompleteMessagePage(store, 'session-1', {
            limit: 2,
            beforeSeq: 7,
            afterSeq: null,
        })
        const newer = readCompleteMessagePage(store, 'session-1', {
            limit: 2,
            beforeSeq: null,
            afterSeq: 6,
        })

        expect(older.messages.map((message) => message.seq)).toEqual([4, 5, 6])
        expect(older.page).toMatchObject({
            direction: 'older',
            range: { startSeq: 4, endSeq: 6 },
            startComplete: true,
            endComplete: true,
            hasOlder: true,
            hasNewer: true,
        })
        expect(newer.messages.map((message) => message.seq)).toEqual([7, 8, 9])
        expect(newer.page).toMatchObject({
            direction: 'newer',
            range: { startSeq: 7, endSeq: 9 },
            startComplete: true,
            endComplete: true,
            hasOlder: true,
            hasNewer: false,
        })
        const combinedIds = [...older.messages, ...newer.messages].map((message) => message.id)
        expect(new Set(combinedIds).size).toBe(combinedIds.length)
    })

    it('reports an explicit older continuation when a single turn crosses the scan budget', () => {
        const messages = [
            storedMessage(1, { role: 'user', content: { type: 'text', text: 'oversized turn' } }),
            ...Array.from({ length: 10_000 }, (_, index) => storedMessage(index + 2, {
                role: 'agent',
                content: { type: 'text', text: `event ${index + 1}` },
            })),
        ]

        const result = readCompleteMessagePage(
            createMemoryMessageStore(messages),
            'session-1',
            { limit: 50, beforeSeq: null, afterSeq: null },
        )

        expect(result.messages).toHaveLength(10_000)
        expect(result.messages[0]?.seq).toBe(2)
        expect(result.messages.at(-1)?.seq).toBe(10_001)
        expect(result.page.startComplete).toBe(false)
        expect(result.page.endComplete).toBe(true)
        expect(result.page.hasOlder).toBe(true)
        expect(result.page.continuation).toEqual({ direction: 'older', cursorSeq: 2 })
    })
})
