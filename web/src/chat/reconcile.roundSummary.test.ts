import { describe, expect, it } from 'vitest'
import { reconcileChatBlocks } from './reconcile'
import type { AgentTextBlock, RoundSummary } from './types'

const summary: RoundSummary = {
    modelUsage: {}, numTurns: 1, durationMs: 2_000,
    generationMs: 1_000, generationOutputTokens: 20
}
const block = (roundSummary: RoundSummary): AgentTextBlock => ({
    kind: 'agent-text', id: 'answer', localId: null, createdAt: 1, text: 'answer', roundSummary
})

describe('round throughput reconciliation', () => {
    it.each([
        { ...summary, generationMs: 500 },
        { ...summary, generationOutputTokens: 40 },
        { ...summary, generationMs: undefined, generationOutputTokens: undefined }
    ])('updates the visible rate when only provider generation data changes: %j', (nextSummary) => {
        const previous = block(summary)
        const next = block(nextSummary)
        const result = reconcileChatBlocks([next], new Map([[previous.id, previous]]))
        expect(result.blocks[0]).toBe(next)
        expect(result.blocks[0]).not.toBe(previous)
    })

    it('retains stable references for unchanged provider generation data', () => {
        const previous = block(summary)
        const result = reconcileChatBlocks([block({ ...summary })], new Map([[previous.id, previous]]))
        expect(result.blocks[0]).toBe(previous)
    })
})
