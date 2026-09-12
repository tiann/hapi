import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OutgoingMessageQueue } from './OutgoingMessageQueue'

describe('OutgoingMessageQueue message filtering', () => {
    let sent: Array<Record<string, unknown>>
    let queue: OutgoingMessageQueue

    beforeEach(() => {
        sent = []
        queue = new OutgoingMessageQueue((msg) => { sent.push(msg) })
    })

    afterEach(() => {
        queue.destroy()
    })

    it('sends normal messages', async () => {
        queue.enqueue({ type: 'assistant', uuid: '1' })
        queue.enqueue({ type: 'user', uuid: '2' })
        await queue.flush()

        expect(sent).toHaveLength(2)
    })

    it('filters hidden system messages but sends visible system messages', async () => {
        queue.enqueue({ type: 'system', subtype: 'init', uuid: '1' })
        queue.enqueue({ type: 'system', subtype: 'turn_duration', uuid: '2' })
        queue.enqueue({ type: 'assistant', uuid: '3' })
        await queue.flush()

        expect(sent).toHaveLength(2)
        expect(sent[0]).toMatchObject({ type: 'system', subtype: 'turn_duration' })
        expect(sent[1]).toMatchObject({ type: 'assistant' })
    })

    it('filters out isMeta messages', async () => {
        queue.enqueue({ type: 'user', isMeta: true, uuid: '1' })
        queue.enqueue({ type: 'assistant', uuid: '2' })
        await queue.flush()

        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ type: 'assistant' })
    })

    it('filters out isCompactSummary messages', async () => {
        queue.enqueue({ type: 'assistant', isCompactSummary: true, uuid: '1' })
        queue.enqueue({ type: 'user', uuid: '2' })
        await queue.flush()

        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ type: 'user' })
    })
})
