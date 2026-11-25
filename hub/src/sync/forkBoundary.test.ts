import { describe, expect, it } from 'bun:test'
import { invokedTailSeq, resolveForkBoundary, resolveRewindBoundary, selectForkTranscriptPrefix } from './forkBoundary'

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

describe('resolveForkBoundary', () => {
    const rows = [
        { localId: 'u1', text: 'q1', invokedAt: 10, createdAt: 10, seq: 1 },
        { localId: 'a1', text: 'r1', invokedAt: 20, createdAt: 20, seq: 2 },
        { localId: 'u2', text: 'q2', invokedAt: 30, createdAt: 30, seq: 3 },
        { localId: 'a2', text: 'r2', invokedAt: 40, createdAt: 40, seq: 4 },
        { localId: 'queued', text: 'later', invokedAt: null, createdAt: 50, seq: 5 }
    ]

    it('keeps every invoked row for current and latestCompleted without a cut', () => {
        for (const mode of ['current', 'latestCompleted'] as const) {
            const resolved = resolveForkBoundary(rows, { mode })
            expect(resolved.prefix.map((row) => row.localId)).toEqual(['u1', 'a1', 'u2', 'a2'])
            expect(resolved.excluded).toEqual([])
            expect(resolved.tailSeq).toBe(4)
        }
    })

    it('cuts before the boundary message for message mode', () => {
        const resolved = resolveForkBoundary(rows, { mode: 'message', messageLocalId: 'u2' })
        expect(resolved.prefix.map((row) => row.localId)).toEqual(['u1', 'a1'])
        expect(resolved.excluded.map((row) => row.localId)).toEqual(['u2', 'a2'])
        expect(resolved.tailSeq).toBe(4)
    })

    it('honors an explicit cutBeforeLocalId for owner-decided cuts', () => {
        const resolved = resolveForkBoundary(rows, { mode: 'latestCompleted', cutBeforeLocalId: 'u2' })
        expect(resolved.prefix.map((row) => row.localId)).toEqual(['u1', 'a1'])
        expect(resolved.excluded.map((row) => row.localId)).toEqual(['u2', 'a2'])
    })

    it('throws when the cut row is missing', () => {
        expect(() => resolveForkBoundary(rows, { mode: 'message', messageLocalId: 'missing' }))
            .toThrow('Fork boundary message not found')
        expect(() => resolveForkBoundary(rows, { mode: 'current', cutBeforeLocalId: 'missing' }))
            .toThrow('Fork boundary message not found')
    })

    it('orders by invocation time before cutting, not insertion seq', () => {
        const lateArrival = [
            { localId: 'user-b', text: 'B', invokedAt: 30, createdAt: 10, seq: 1 },
            { localId: 'a-reply', text: 'A-reply', invokedAt: 20, createdAt: 20, seq: 2 }
        ]
        const resolved = resolveForkBoundary(lateArrival, { mode: 'message', messageLocalId: 'user-b' })
        expect(resolved.prefix.map((row) => row.localId)).toEqual(['a-reply'])
        expect(resolved.excluded.map((row) => row.localId)).toEqual(['user-b'])
    })

    it('splits rows sharing the boundary position by seq, like the truncate rule', () => {
        const tied = [
            { localId: 'first', text: '1', invokedAt: 10, createdAt: 10, seq: 1 },
            { localId: 'second', text: '2', invokedAt: 10, createdAt: 10, seq: 2 }
        ]
        const resolved = resolveForkBoundary(tied, { mode: 'message', messageLocalId: 'second' })
        expect(resolved.prefix.map((row) => row.localId)).toEqual(['first'])
        expect(resolved.excluded.map((row) => row.localId)).toEqual(['second'])
    })

    it('reports an empty tailSeq for a transcript without invoked rows', () => {
        const resolved = resolveForkBoundary([{ localId: null, text: 'x', invokedAt: null, createdAt: 1, seq: 9 }], { mode: 'current' })
        expect(resolved.prefix).toEqual([])
        expect(resolved.tailSeq).toBe(0)
    })
})

describe('resolveRewindBoundary', () => {
    const rows = [
        { localId: 'u1', text: 'q1', invokedAt: 10, createdAt: 10, seq: 1 },
        { localId: 'a1', text: 'r1', invokedAt: 20, createdAt: 20, seq: 2 },
        { localId: 'u2', text: 'q2', invokedAt: 30, createdAt: 30, seq: 3 },
        { localId: 'a2', text: 'r2', invokedAt: 40, createdAt: 40, seq: 4 },
        { localId: 'queued', text: 'later', invokedAt: null, createdAt: 50, seq: 5 }
    ]

    it('keeps rows before the boundary and deletes from it onward', () => {
        const resolved = resolveRewindBoundary(rows, 'u2')
        expect(resolved.prefix.map((row) => row.localId)).toEqual(['u1', 'a1'])
        expect(resolved.excluded.map((row) => row.localId)).toEqual(['u2', 'a2', 'queued'])
        expect(resolved.tailSeq).toBe(4)
    })

    it('deletes the whole transcript when rewinding at the first row', () => {
        const resolved = resolveRewindBoundary(rows, 'u1')
        expect(resolved.prefix).toEqual([])
        expect(resolved.excluded).toHaveLength(5)
    })

    it('throws when the rewind boundary row is missing', () => {
        expect(() => resolveRewindBoundary(rows, 'missing')).toThrow('Fork boundary message not found')
    })
})

describe('invokedTailSeq', () => {
    it('ignores uninvoked rows', () => {
        expect(invokedTailSeq([
            { localId: 'a', invokedAt: 1, createdAt: 1, seq: 3 },
            { localId: 'b', invokedAt: null, createdAt: 2, seq: 9 }
        ])).toBe(3)
    })
})
