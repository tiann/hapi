import { describe, expect, it } from 'vitest'

import { reconcileChatBlocks } from './reconcile'
import type { ChatBlock } from './types'

describe('reconcileChatBlocks', () => {
    it('replaces agent text blocks when seq changes', () => {
        const previous: ChatBlock = {
            kind: 'agent-text',
            id: 'assistant:1',
            seq: null,
            localId: null,
            createdAt: 1,
            text: 'answer'
        }
        const prevById = new Map([[previous.id, previous]])
        const next: ChatBlock = {
            ...previous,
            seq: 7
        }

        const result = reconcileChatBlocks([next], prevById)

        expect(result.blocks[0]).toBe(next)
        expect(result.blocks[0]).not.toBe(previous)
    })

    it('replaces agent reasoning blocks when seq changes', () => {
        const previous: ChatBlock = {
            kind: 'agent-reasoning',
            id: 'assistant:reasoning:1',
            seq: null,
            localId: null,
            createdAt: 1,
            text: 'thinking'
        }
        const prevById = new Map([[previous.id, previous]])
        const next: ChatBlock = {
            ...previous,
            seq: 7
        }

        const result = reconcileChatBlocks([next], prevById)

        expect(result.blocks[0]).toBe(next)
        expect(result.blocks[0]).not.toBe(previous)
    })
})
