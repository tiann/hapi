import { describe, expect, it } from 'vitest'
import { buildForkPreviewView } from './forkPreview'
import type { ForkPreviewResponse } from '@hapi/protocol/forkBoundary'
import type { DecryptedMessage } from '@/types/api'

function userRow(id: string, seq: number, text: string): DecryptedMessage {
    return { id, seq, localId: `${id}-local`, createdAt: seq * 1000, invokedAt: seq * 1000,
        content: { role: 'user', content: { type: 'text', text } } }
}
function agentRow(id: string, seq: number, text: string): DecryptedMessage {
    return { id, seq, localId: `${id}-local`, createdAt: seq * 1000,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: text } } } }
}
function reasoningRow(id: string, seq: number, text: string): DecryptedMessage {
    return { id, seq, localId: null, createdAt: seq * 1000,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: text, id: `stream-${id}` } } } }
}

function response(overrides: Partial<ForkPreviewResponse> = {}): ForkPreviewResponse {
    return {
        mode: 'current',
        boundary: { v: 1, mode: 'current', epoch: 1, tailSeq: 4 },
        keptTail: [
            userRow('u1', 1, 'first question'),
            agentRow('a1', 2, 'first answer'),
            userRow('u2', 3, 'second question')
        ],
        excluded: [],
        counts: { kept: 3, excluded: 0 },
        ...overrides
    }
}

describe('buildForkPreviewView', () => {
    it('compacts hub kept rows into alternating text turns', () => {
        const view = buildForkPreviewView(response())
        expect(view.kind).toBe('current')
        expect(view.keptTurns).toEqual([
            { role: 'user', text: 'first question' },
            { role: 'assistant', text: 'first answer' },
            { role: 'user', text: 'second question' }
        ])
        expect(view.boundaryText).toBeNull()
        expect(view.prefixTruncated).toBe(false)
        expect(view.excludedTurns).toEqual([])
    })

    it('caps the compact view at the last turns and flags the omitted prefix', () => {
        const view = buildForkPreviewView(response({
            keptTail: [
                userRow('u1', 1, 'first question'),
                agentRow('a1', 2, 'first answer'),
                userRow('u2', 3, 'second question'),
                agentRow('a2', 4, 'second answer')
            ],
            counts: { kept: 4, excluded: 0 }
        }))
        expect(view.keptTurns).toHaveLength(3)
        expect(view.keptTurns[0]).toEqual({ role: 'assistant', text: 'first answer' })
        expect(view.prefixTruncated).toBe(true)
    })

    it('truncates long text to the compact preview length', () => {
        const long = 'x'.repeat(400)
        const view = buildForkPreviewView(response({
            keptTail: [userRow('u1', 1, long)],
            counts: { kept: 1, excluded: 0 }
        }))
        expect(view.keptTurns[0]?.text.length).toBeLessThanOrEqual(241)
        expect(view.keptTurns[0]?.text.endsWith('…')).toBe(true)
    })

    it('flags truncation when the hub windowed the kept tail', () => {
        const view = buildForkPreviewView(response({
            keptTail: [userRow('u2', 3, 'second question')],
            counts: { kept: 9, excluded: 0 }
        }))
        expect(view.prefixTruncated).toBe(true)
    })

    it('flags truncation when copied non-text rows are omitted from the compact view', () => {
        const view = buildForkPreviewView(response({
            keptTail: [userRow('u1', 1, 'first question'), reasoningRow('r1', 2, 'private chain of thought')],
            counts: { kept: 2, excluded: 0 }
        }))
        expect(view.keptTurns).toEqual([{ role: 'user', text: 'first question' }])
        expect(view.prefixTruncated).toBe(true)
    })

    it('names the boundary row text for a historical fork', () => {
        const view = buildForkPreviewView(response({
            mode: 'message',
            boundary: { v: 1, mode: 'message', messageLocalId: 'u3-local', epoch: 1, tailSeq: 4 },
            keptTail: [userRow('u1', 1, 'first question')],
            excluded: [userRow('u3', 5, 'third question')],
            counts: { kept: 1, excluded: 1 }
        }))
        expect(view.kind).toBe('message')
        expect(view.boundaryText).toBe('third question')
        expect(view.excludedTurns).toEqual([])
    })

    it('carries the rewind deleted region and its truncation flag', () => {
        const view = buildForkPreviewView(response({
            mode: 'rewind',
            boundary: { v: 1, mode: 'rewind', messageLocalId: 'u2-local', epoch: 1, tailSeq: 4 },
            keptTail: [userRow('u1', 1, 'first question')],
            excluded: [userRow('u2', 3, 'second question'), agentRow('a2', 4, 'second answer')],
            counts: { kept: 1, excluded: 5 }
        }))
        expect(view.kind).toBe('rewind')
        expect(view.boundaryText).toBe('second question')
        expect(view.excludedTurns).toEqual([
            { role: 'user', text: 'second question' },
            { role: 'assistant', text: 'second answer' }
        ])
        expect(view.excludedTruncated).toBe(true)
        expect(view.counts.excluded).toBe(5)
    })

    it('marks the rewind region complete when everything deleted is shown', () => {
        const view = buildForkPreviewView(response({
            mode: 'rewind',
            boundary: { v: 1, mode: 'rewind', messageLocalId: 'u2-local', epoch: 1, tailSeq: 4 },
            keptTail: [userRow('u1', 1, 'first question')],
            excluded: [userRow('u2', 3, 'second question')],
            counts: { kept: 1, excluded: 1 }
        }))
        expect(view.excludedTruncated).toBe(false)
    })
})