import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from './reducer'
import { reconcileChatBlocks } from './reconcile'
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

    it('ignores Claude subagent usage when calculating parent latest usage', () => {
        // Claude never stamps scope_role, so a Task subagent's assistant
        // messages look like ordinary parent usage apart from isSidechain.
        // Letting them through made the status bar's ctx numerator collapse
        // while a subagent ran and snap back when the parent resumed.
        const messages: NormalizedMessage[] = [
            {
                id: 'parent-turn',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'agent',
                content: [],
                isSidechain: false,
                usage: {
                    input_tokens: 500,
                    output_tokens: 20,
                    cache_read_input_tokens: 120_000,
                    context_window: 200_000
                }
            },
            {
                id: 'subagent-turn',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'agent',
                content: [],
                isSidechain: true,
                parentToolUseId: 'tc-task-1',
                usage: {
                    input_tokens: 300,
                    output_tokens: 5,
                    cache_read_input_tokens: 8_000,
                    context_window: 200_000
                }
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toMatchObject({
            inputTokens: 500,
            outputTokens: 20,
            cacheRead: 120_000,
            contextSize: 120_500
        })
    })

    it('carries the usage message model for the context-window heuristic', () => {
        // Local-mode Claude transcripts have no context_window in usage and
        // session.model is often null, so latestUsage.model is the only
        // signal the status bar has to resolve a plausible window.
        const messages: NormalizedMessage[] = [
            {
                id: 'local-turn',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'agent',
                content: [],
                isSidechain: false,
                model: 'claude-fable-5',
                usage: {
                    input_tokens: 2,
                    output_tokens: 50,
                    cache_read_input_tokens: 250_000
                }
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toMatchObject({
            contextSize: 250_002,
            contextWindow: null,
            model: 'claude-fable-5'
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

    it('attaches a result summary to the first block in the preceding contiguous assistant group', () => {
        const summary = {
            usage: { input_tokens: 100, output_tokens: 20 },
            modelUsage: { 'claude-opus-5': { inputTokens: 100, outputTokens: 20 } },
            totalCostUsd: 0.02,
            numTurns: 2,
            durationMs: 1500
        }
        const messages: NormalizedMessage[] = [
            userMessage('u1', 'hello', 1),
            {
                id: 'a1', localId: 'turn-1', createdAt: 2, role: 'agent', isSidechain: false,
                content: [{ type: 'text', text: 'thinking', uuid: 'a1', parentUUID: null }]
            },
            {
                id: 'a2', localId: 'turn-2', createdAt: 3, role: 'agent', isSidechain: false,
                content: [{ type: 'text', text: 'answer', uuid: 'a2', parentUUID: 'a1' }]
            },
            {
                id: 'summary', localId: null, createdAt: 4, role: 'event', isSidechain: false,
                content: { type: 'turn-summary', summary } as any
            }
        ]

        const reduced = reduceChatBlocks(messages, null)
        const firstAssistant = reduced.blocks.find(block => block.kind === 'agent-text' && block.id.startsWith('a1'))
        expect((firstAssistant as any)?.roundSummary).toEqual(summary)
        const secondAssistant = reduced.blocks.find(block => block.kind === 'agent-text' && block.id.startsWith('a2'))
        expect((secondAssistant as any)?.roundSummary).toBeUndefined()
    })

    it('keeps a sidechain result summary on the subagent card instead of the next root response', () => {
        const summary = {
            modelUsage: { 'claude-opus-5': { inputTokens: 10, outputTokens: 2 } },
            totalCostUsd: 0.01,
            numTurns: 1,
            durationMs: 800
        }
        const messages: NormalizedMessage[] = [
            {
                id: 'agent-tool', localId: null, createdAt: 1, role: 'agent', isSidechain: false,
                content: [{
                    type: 'tool-call', id: 'toolu-agent-1', name: 'Agent',
                    input: { prompt: 'inspect the code', subagent_type: 'general-purpose' },
                    description: null, uuid: 'root-1', parentUUID: null
                }]
            },
            {
                id: 'sidechain-answer', localId: null, createdAt: 2, role: 'agent', isSidechain: true,
                parentToolUseId: 'toolu-agent-1',
                content: [{ type: 'text', text: 'subagent answer', uuid: 'side-1', parentUUID: null }]
            },
            {
                id: 'sidechain-summary', localId: null, createdAt: 3, role: 'event', isSidechain: true,
                parentToolUseId: 'toolu-agent-1',
                content: { type: 'turn-summary', summary } as any
            },
            {
                id: 'root-answer', localId: null, createdAt: 4, role: 'agent', isSidechain: false,
                content: [{ type: 'text', text: 'root answer', uuid: 'root-2', parentUUID: 'root-1' }]
            }
        ]

        const reduced = reduceChatBlocks(messages, null)
        const agentCard = reduced.blocks.find(block => block.kind === 'tool-call')
        const sidechainAnswer = agentCard?.kind === 'tool-call'
            ? agentCard.children.find(block => block.kind === 'agent-text')
            : undefined
        const rootAnswer = reduced.blocks.find(block => block.kind === 'agent-text')

        expect(sidechainAnswer?.kind === 'agent-text' ? sidechainAnswer.roundSummary : undefined).toEqual(summary)
        expect(rootAnswer?.kind === 'agent-text' ? rootAnswer.roundSummary : undefined).toBeUndefined()
    })

    it('keeps a late result summary when reconciling an existing assistant block', () => {
        const summary = {
            usage: { input_tokens: 10, output_tokens: 2 },
            modelUsage: { 'claude-haiku-4-5': { inputTokens: 10, outputTokens: 2 } },
            totalCostUsd: 0.02,
            numTurns: 1,
            durationMs: 1200
        }
        const baseMessages: NormalizedMessage[] = [
            userMessage('u1', 'hello', 1),
            {
                id: 'a1', localId: 'turn-1', createdAt: 2, role: 'agent', isSidechain: false,
                content: [{ type: 'text', text: 'answer', uuid: 'a1', parentUUID: null }]
            }
        ]
        const before = reduceChatBlocks(baseMessages, null)
        const previousById = new Map(before.blocks.map(block => [block.id, block]))
        const after = reduceChatBlocks([
            ...baseMessages,
            {
                id: 'summary', localId: null, createdAt: 3, role: 'event', isSidechain: false,
                content: { type: 'turn-summary', summary } as any
            }
        ], null)

        const reconciled = reconcileChatBlocks(after.blocks, previousById)
        const assistant = reconciled.blocks.find(block => block.kind === 'agent-text')
        expect(assistant?.kind === 'agent-text' ? assistant.roundSummary : undefined).toEqual(summary)
    })
})
