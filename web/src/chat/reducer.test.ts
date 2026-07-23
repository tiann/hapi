import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from './reducer'
import { normalizeDecryptedMessage } from './normalize'
import type { NormalizedMessage } from './types'
import type { DecryptedMessage } from '@/types/api'
import type { AgentState, ThreadGoal, ThreadGoalStatus } from '@/types/api'

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

function eventMessage(id: string, message: string, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'event',
        content: {
            type: 'message',
            message
        },
        isSidechain: false
    }
}

function decryptedMessage(id: string, content: unknown, createdAt: number): DecryptedMessage {
    return {
        id,
        seq: 1,
        localId: null,
        content,
        createdAt
    }
}

describe('reduceChatBlocks', () => {
    it('renders Codex proposed plan tool messages as a completed plan card', () => {
        const plan = '# Plan\n\n1. Inspect\n2. Implement'
        const messages = [
            decryptedMessage('plan-call', {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call',
                        name: 'ExitPlanMode',
                        callId: 'codex-proposed-plan:plan-1',
                        input: { plan },
                        id: 'plan-1'
                    }
                }
            }, 1),
            decryptedMessage('plan-result', {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call-result',
                        callId: 'codex-proposed-plan:plan-1',
                        output: null,
                        id: 'plan-1:result'
                    }
                }
            }, 2)
        ].map(message => normalizeDecryptedMessage(message))
            .filter((message): message is NormalizedMessage => message !== null)

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.blocks).toContainEqual(expect.objectContaining({
            kind: 'tool-call',
            id: 'codex-proposed-plan:plan-1',
            tool: expect.objectContaining({
                name: 'ExitPlanMode',
                state: 'completed',
                input: { plan },
                result: null
            })
        }))
    })

    it('coalesces repeated OMP Subagent progress calls by callId', () => {
        const messages = [
            {
                id: 'subagent-start',
                localId: null,
                createdAt: 1,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'omp-subagent:child-1',
                    name: 'Agent',
                    input: { activity: 'Starting', tokens: 0 },
                    description: null,
                    uuid: 'subagent-start',
                    parentUUID: null
                }],
                isSidechain: false
            },
            {
                id: 'subagent-progress',
                localId: null,
                createdAt: 2,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'omp-subagent:child-1',
                    name: 'Agent',
                    input: { activity: 'Reading loop.ts', tokens: 1200 },
                    description: null,
                    uuid: 'subagent-progress',
                    parentUUID: null
                }],
                isSidechain: false
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)
        const cards = reduced.blocks.filter(block => block.kind === 'tool-call' && block.id === 'omp-subagent:child-1')

        expect(cards).toHaveLength(1)
        expect(cards[0]).toMatchObject({
            tool: {
                input: { activity: 'Reading loop.ts', tokens: 1200 }
            }
        })
    })

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

    it('can clear completed goal state using messages hidden from the rendered timeline', () => {
        const renderedMessages = [
            goalMessage('goal-complete', 'complete', 1)
        ]
        const goalStateMessages = [
            ...renderedMessages,
            userMessage('queued-user-later', 'start a new task', 2)
        ]

        const reduced = reduceChatBlocks(renderedMessages, null, { goalStateMessages })

        expect(reduced.blocks).toHaveLength(0)
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

    it('uses goal events for latest goal state without rendering timeline prompts', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-active', 'active', 1)
        ], null)

        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestGoal).toMatchObject({
            threadId: 'thread-1',
            objective: 'ship goal support',
            status: 'active'
        })
    })

    it('uses goal clear events to clear latest goal without rendering timeline prompts', () => {
        const reduced = reduceChatBlocks([
            goalMessage('goal-active', 'active', 1),
            goalClearedMessage('goal-cleared', 2)
        ], null)

        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestGoal).toBeNull()
    })

    it('hides redundant goal status messages but keeps actionable goal messages', () => {
        const reduced = reduceChatBlocks([
            eventMessage('goal-active-message', 'Goal active', 1),
            eventMessage('goal-active-usage-message', 'Goal active · 181737 tokens', 2),
            eventMessage('goal-complete-message', 'Goal complete', 3),
            eventMessage('goal-cleared-message', 'Goal cleared', 4),
            eventMessage('goal-actionable-message', 'No goal to clear', 5)
        ], null)

        expect(reduced.blocks).toHaveLength(1)
        expect(reduced.blocks[0]).toMatchObject({
            kind: 'agent-event',
            event: { type: 'message', message: 'No goal to clear' }
        })
    })

    it('hides persisted goal status event envelopes alongside structured goal events', () => {
        const goal: ThreadGoal = {
            threadId: 'thread-1',
            objective: 'ship goal support',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 8016,
            timeUsedSeconds: 10,
            createdAt: 1,
            updatedAt: 2
        }
        const normalized = [
            decryptedMessage('goal-status-envelope', {
                role: 'agent',
                content: {
                    id: 'event-1',
                    type: 'event',
                    data: { type: 'message', message: 'Goal active · 8016 tokens' }
                }
            }, 1),
            decryptedMessage('goal-structured-envelope', {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'thread_goal_updated',
                        thread_id: 'thread-1',
                        goal
                    }
                }
            }, 2)
        ].map(message => normalizeDecryptedMessage(message))
            .filter((message): message is NormalizedMessage => message !== null)

        const reduced = reduceChatBlocks(normalized, null)

        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestGoal).toMatchObject({
            threadId: 'thread-1',
            status: 'active',
            tokensUsed: 8016
        })
    })

    it('does not pin a resolved request as a bottom card when its message is not in the window', () => {
        // agentState keeps completedRequests after an ask is answered. With no
        // tool_use message loaded for it, the permission-only synthesis used to
        // append an "answered" card at the end of the timeline (no re-sort),
        // pinning it above the composer forever.
        const messages = [userMessage('u1', 'hello', 1_700_000_000_000)]
        const agentState = {
            requests: {},
            completedRequests: {
                'ask-done': {
                    tool: 'AskUserQuestion',
                    arguments: { questions: [] },
                    status: 'approved',
                    createdAt: 1_700_000_000_500,
                    completedAt: 1_700_000_000_600
                }
            }
        } as unknown as AgentState

        const reduced = reduceChatBlocks(messages, agentState)
        expect(reduced.blocks.some(b => b.kind === 'tool-call' && b.id === 'ask-done')).toBe(false)
    })

    it('still synthesizes a card for a pending request with no message in the window', () => {
        const messages = [userMessage('u1', 'hello', 1_700_000_000_000)]
        const agentState = {
            requests: {
                'ask-pending': { tool: 'AskUserQuestion', arguments: { questions: [] }, createdAt: 1_700_000_000_500 }
            },
            completedRequests: {}
        } as unknown as AgentState

        const reduced = reduceChatBlocks(messages, agentState)
        const block = reduced.blocks.find(b => b.kind === 'tool-call' && b.id === 'ask-pending')
        expect(block).toBeDefined()
        expect(block?.kind === 'tool-call' ? block.tool.permission?.status : null).toBe('pending')
    })
})
