import { describe, expect, it } from 'bun:test'
import { selectForkTranscriptPrefix } from './forkTranscript'

describe('selectForkTranscriptPrefix', () => {
    const messages = [
        { localId: 'a', text: '1', invokedAt: 1, createdAt: 1, seq: 1 },
        { localId: null, text: '2', invokedAt: 2, createdAt: 2, seq: 2 },
        { localId: 'b', text: '3', invokedAt: 3, createdAt: 3, seq: 3 },
        { localId: null, text: '4', invokedAt: 4, createdAt: 4, seq: 4 },
        { localId: 'pending', text: 'scheduled', invokedAt: null, createdAt: 5, seq: 5 }
    ]

    it('copies the full invoked transcript for current fork', () => {
        expect(selectForkTranscriptPrefix(messages).map((message) => message.text)).toEqual([
            '1', '2', '3', '4'
        ])
    })

    it('excludes the boundary message and later turns for historical fork', () => {
        expect(selectForkTranscriptPrefix(messages, 'b').map((message) => message.text)).toEqual([
            '1', '2'
        ])
    })

    it('never copies pending scheduled rows', () => {
        expect(selectForkTranscriptPrefix(messages).some((message) => message.localId === 'pending')).toBe(false)
        expect(selectForkTranscriptPrefix(messages, 'pending').map((message) => message.text)).toEqual([
            '1', '2', '3', '4'
        ])
    })

    it('orders by invocation time before slicing, not insertion seq', () => {
        const queuedThenAnswered = [
            { localId: 'user-b', text: 'B', invokedAt: 30, createdAt: 10, seq: 1 },
            { localId: null, text: 'A-reply', invokedAt: 20, createdAt: 20, seq: 2 }
        ]
        expect(selectForkTranscriptPrefix(queuedThenAnswered, 'user-b').map((message) => message.text)).toEqual([
            'A-reply'
        ])
    })

    it('throws when the boundary localId is missing', () => {
        expect(() => selectForkTranscriptPrefix(messages, 'missing')).toThrow(
            'Fork boundary message not found'
        )
    })
})
