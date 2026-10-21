import { describe, expect, it, vi } from 'vitest'
import { AppServerEventConverter } from './appServerEventConverter'

describe('Codex assistant snapshots', () => {
    it('emits growing text before completion and reconciles the authoritative final item', () => {
        const converter = new AppServerEventConverter({ streamText: true })
        const scope = { threadId: 'thread', turnId: 'turn', itemId: 'answer' }
        const partial = converter.handleNotification('item/agentMessage/delta', { ...scope, delta: 'Hello' })
            .find(event => event.type === 'agent_message')!
        expect(partial).toMatchObject({ message: 'Hello', live: true, stream_id: expect.any(String) })
        const final = converter.handleNotification('item/completed', {
            ...scope, item: { id: 'answer', type: 'agentMessage', text: 'Hello world!' }
        }).find(event => event.type === 'agent_message')!
        expect(final).toMatchObject({ message: 'Hello world!', stream_id: partial.stream_id })
        expect(final.live).not.toBe(true)
    })

    it('throttles snapshots but preserves identical consecutive canonical deltas', () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
        try {
            const converter = new AppServerEventConverter({ streamText: true })
            const scope = { itemId: 'answer' }
            converter.handleNotification('item/agentMessage/delta', { ...scope, delta: 'ha' })
            const next = converter.handleNotification('item/agentMessage/delta', { ...scope, delta: 'ha' })
            expect(next.filter(event => event.type === 'agent_message')).toEqual([])
            expect(converter.handleNotification('item/completed', { item: { id: 'answer', type: 'agentMessage' } }))
                .toContainEqual(expect.objectContaining({ type: 'agent_message', message: 'haha' }))
        } finally { clock.mockRestore() }
    })

    it('ignores legacy mirrors without dropping legitimate equal fragments', () => {
        const converter = new AppServerEventConverter({ streamText: true })
        converter.handleNotification('item/agentMessage/delta', { itemId: 'answer', delta: 'ha' })
        converter.handleNotification('codex/event/agent_message_delta', {
            msg: { type: 'agent_message_delta', item_id: 'answer', delta: 'ha' }
        })
        converter.handleNotification('item/agentMessage/delta', { itemId: 'answer', delta: 'ha' })
        expect(converter.handleNotification('item/completed', { item: { id: 'answer', type: 'agentMessage' } }))
            .toContainEqual(expect.objectContaining({ message: 'haha' }))
        expect(converter.handleNotification('item/agentMessage/delta', { itemId: 'answer', delta: 'late' })).toEqual([])
    })
})
