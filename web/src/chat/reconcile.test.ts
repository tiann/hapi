import { describe, expect, it } from 'vitest'
import { reconcileChatBlocks } from './reconcile'
import type { AgentTextBlock } from './types'

describe('reconcileChatBlocks', () => {
    it('does not reuse stale assistant blocks when the completion timestamp changes', () => {
        const pending: AgentTextBlock = {
            kind: 'agent-text',
            id: 'agent-1:0',
            localId: null,
            createdAt: 1_700_000_000_000,
            text: 'Streaming reply',
            meta: undefined
        }
        const first = reconcileChatBlocks([pending], new Map())
        const completed: AgentTextBlock = {
            ...pending,
            displayTimestamp: 1_700_000_030_000
        }

        const second = reconcileChatBlocks([completed], first.byId)

        expect(second.blocks[0]).toBe(completed)
        expect(second.blocks[0]).toMatchObject({
            kind: 'agent-text',
            displayTimestamp: 1_700_000_030_000
        })
    })
})
