import { describe, expect, it } from 'bun:test'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { Store } from './index'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string) {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

function makeToolCall(callId: string, status: string, input: Record<string, unknown> = { cmd: 'ls' }) {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'tool-call', callId, name: 'bash', input, status }
        }
    }
}

function makeToolResult(callId: string, output = 'ok') {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'tool-call-result', callId, output }
        }
    }
}

function makeReasoning(streamId: string, text: string, live: boolean) {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'reasoning', message: text, id: streamId, ...(live ? { live: true } : {}) }
        }
    }
}

describe('liveTailCache & cursor pagination', () => {
    it('keeps repeated tool-call upserts and reasoning replacements consistent on a 500-message session', () => {
        const store = makeStore()
        const session = makeSession(store, 'tail-large-session')

        for (let i = 0; i < 500; i += 1) {
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: `history-${i}` } }
            })
        }

        const firstTool = store.messages.upsertToolCallMessage(session.id, makeToolCall('call-live', 'pending'), 'call-live')
        expect(firstTool.updated).toBe(false)

        for (let tick = 0; tick < 20; tick += 1) {
            const status = tick === 19 ? 'completed' : 'in_progress'
            const next = store.messages.upsertToolCallMessage(
                session.id,
                makeToolCall('call-live', status, { cmd: 'ls', tick }),
                'call-live'
            )
            expect(next.updated).toBe(true)
            expect(next.message.id).toBe(firstTool.message.id)
        }

        let lastReasoningId = ''
        for (let chunk = 0; chunk < 20; chunk += 1) {
            const stored = store.messages.addMessage(
                session.id,
                makeReasoning('stream-live', `thinking-${chunk}`, chunk < 19)
            )
            store.messages.deleteLiveReasoningSnapshots(session.id, 'stream-live', stored.id)
            lastReasoningId = stored.id
        }

        const all = store.messages.getAllMessages(session.id)
        // 500 history + 1 upserted tool call + 1 settled reasoning row
        expect(all).toHaveLength(502)
        expect(all.at(-1)?.id).toBe(lastReasoningId)
    })

    it('handles deleteLiveReasoningSnapshots without keepMessageId cleanly when deleting head row', () => {
        const store = makeStore()
        const session = makeSession(store, 'tail-delete-head')

        const first = store.messages.addMessage(session.id, makeReasoning('stream-a', 'chunk-1', true))
        const second = store.messages.addMessage(session.id, makeReasoning('stream-a', 'chunk-2', true))
        expect(second.seq).toBeGreaterThan(first.seq)

        const removed = store.messages.deleteLiveReasoningSnapshots(session.id, 'stream-a')
        expect(removed).toBe(2)

        const replacement = store.messages.addMessage(session.id, makeReasoning('stream-a', 'settled', false))
        expect(store.messages.getAllMessages(session.id).map((m) => m.id)).toEqual([replacement.id])
    })

    it('stops reusing a cached live tool call after tool-call-result or a user turn boundary', () => {
        const store = makeStore()
        const session = makeSession(store, 'tail-boundaries')

        const callA1 = store.messages.upsertToolCallMessage(session.id, makeToolCall('call-A', 'in_progress'), 'call-A')
        store.messages.addMessage(session.id, makeToolResult('call-A', 'done'))

        const callA2 = store.messages.upsertToolCallMessage(session.id, makeToolCall('call-A', 'in_progress'), 'call-A')
        expect(callA2.updated).toBe(false)
        expect(callA2.message.id).not.toBe(callA1.message.id)

        const callB1 = store.messages.upsertToolCallMessage(session.id, makeToolCall('call-B', 'in_progress'), 'call-B')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'next turn' } })

        const callB2 = store.messages.upsertToolCallMessage(session.id, makeToolCall('call-B', 'in_progress'), 'call-B')
        expect(callB2.updated).toBe(false)
        expect(callB2.message.id).not.toBe(callB1.message.id)
    })

    it('invalidates the live tail cache on rewind truncation', () => {
        const store = makeStore()
        const session = makeSession(store, 'tail-rewind')

        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'turn-1' } }, 'lid-1')
        store.messages.upsertToolCallMessage(session.id, makeToolCall('call-rewind', 'in_progress'), 'call-rewind')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'turn-2' } }, 'lid-2')
        store.messages.upsertToolCallMessage(session.id, makeToolCall('call-after', 'in_progress'), 'call-after')

        store.messages.truncateMessagesFromLocalId(session.id, 'lid-2')

        // call-after was rewound; call-rewind survived and remains updatable.
        const freshAfter = store.messages.upsertToolCallMessage(session.id, makeToolCall('call-after', 'in_progress'), 'call-after')
        expect(freshAfter.updated).toBe(false)

        store.messages.truncateMessagesFromLocalId(session.id, 'lid-1')
        const restarted = store.messages.upsertToolCallMessage(session.id, makeToolCall('call-rewind', 'in_progress'), 'call-rewind')
        expect(restarted.updated).toBe(false)
    })

    it('scans across multiple cursor pages in hasConversationContent without skipping rows', () => {
        const store = makeStore()
        const session = makeSession(store, 'cursor-conv-check')

        for (let i = 0; i < 40; i += 1) {
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'event', payload: { idx: i } } }
            })
        }
        expect(store.messages.hasConversationContent(session.id)).toBe(false)

        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'actual prompt' } })
        expect(store.messages.hasConversationContent(session.id)).toBe(true)
    })
})
