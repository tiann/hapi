import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from './reducer'
import type { NormalizedMessage } from './types'
import type { ThreadGoal, ThreadGoalStatus } from '@/types/api'

function userMessage(id: string, text: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'user',
        content: { type: 'text', text },
        isSidechain: false
    }
}

function goalMessage(id: string, status: ThreadGoalStatus, createdAt: number): NormalizedMessage {
    const goal: ThreadGoal = {
        threadId: 'thread-1',
        objective: 'ship goal support',
        status,
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt,
        updatedAt: createdAt
    }
    return {
        id,
        localId: null,
        createdAt,
        role: 'event',
        content: {
            type: 'thread-goal-updated',
            threadId: 'thread-1',
            goal
        },
        isSidechain: false
    }
}

function goalClearedMessage(id: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'event',
        content: {
            type: 'thread-goal-cleared',
            threadId: 'thread-1'
        },
        isSidechain: false
    }
}

describe('reduceChatBlocks', () => {
    it('ignores child agent usage when calculating parent latest usage', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'parent-usage',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: { type: 'token-count', info: {} },
                isSidechain: false,
                usage: {
                    input_tokens: 100,
                    output_tokens: 10,
                    context_tokens: 100,
                    scope_role: 'parent'
                }
            },
            {
                id: 'child-usage',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: { type: 'token-count', info: {} },
                isSidechain: false,
                usage: {
                    input_tokens: 999,
                    output_tokens: 1,
                    context_tokens: 999,
                    scope_role: 'child'
                }
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toMatchObject({
            inputTokens: 100,
            outputTokens: 10,
            contextSize: 100
        })
    })

    it('keeps active goals visible across later normal user messages', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-active', 'active', 1),
            userMessage('user-later', 'continue working', 2)
        ], null)

        expect(reduced.latestGoal).toMatchObject({
            status: 'active',
            objective: 'ship goal support'
        })
    })

    it('keeps a completed goal visible when it is the latest relevant event', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-complete', 'complete', 1)
        ], null)

        expect(reduced.latestGoal).toMatchObject({
            status: 'complete',
            objective: 'ship goal support'
        })
    })

    it('hides a completed goal after a later non-goal user message', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-complete', 'complete', 1),
            userMessage('user-later', 'start a new task', 2)
        ], null)

        expect(reduced.latestGoal).toBeNull()
    })

    it('does not treat later goal slash commands as non-goal activity', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-complete', 'complete', 1),
            userMessage('user-later', '/goal', 2)
        ], null)

        expect(reduced.latestGoal).toMatchObject({
            status: 'complete'
        })
    })

    it('treats slash commands with a goal prefix as non-goal activity', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-complete', 'complete', 1),
            userMessage('user-later', '/goal-foo', 2)
        ], null)

        expect(reduced.latestGoal).toBeNull()
    })

    it('clears latest goal after an explicit goal clear event', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-active', 'active', 1),
            goalClearedMessage('goal-cleared', 2)
        ], null)

        expect(reduced.latestGoal).toBeNull()
    })
})
