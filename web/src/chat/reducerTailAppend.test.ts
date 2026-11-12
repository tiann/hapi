import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from './reducer'
import {
    reduceChatBlocksWithTailAppend,
    type TailAppendReduceState
} from './reducerTailAppend'
import type { AgentEvent, NormalizedMessage, NormalizedAgentContent } from './types'
import type { AgentState, ThreadGoal, ThreadGoalStatus } from '@/types/api'

const SESSION = 'session-1'

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

function agentMessage(
    id: string,
    parts: NormalizedAgentContent[],
    createdAt: number,
    extra: Partial<NormalizedMessage> = {}
): NormalizedMessage {
    return {
        ...extra,
        id,
        localId: null,
        createdAt,
        isSidechain: false,
        role: 'agent',
        content: parts
    }
}

function textPart(text: string, uuid: string, streamId?: string): NormalizedAgentContent {
    return { type: 'text', text, uuid, streamId, parentUUID: null }
}

function toolCallPart(id: string, name = 'Bash', input: unknown = { command: 'ls' }): NormalizedAgentContent {
    return {
        type: 'tool-call',
        id,
        name,
        input,
        description: null,
        uuid: `${id}:uuid`,
        parentUUID: null
    }
}

function toolResultPart(id: string, content: unknown = 'ok'): NormalizedAgentContent {
    return {
        type: 'tool-result',
        tool_use_id: id,
        content,
        is_error: false,
        uuid: `${id}:result-uuid`,
        parentUUID: null
    }
}

function eventMessage(id: string, content: AgentEvent, createdAt: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        role: 'event',
        content,
        isSidechain: false
    }
}

function goalMessage(id: string, status: ThreadGoalStatus, createdAt: number): NormalizedMessage {
    const goal: ThreadGoal = {
        threadId: 'thread-1',
        objective: 'ship it',
        status,
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt,
        updatedAt: createdAt
    }
    return eventMessage(id, { type: 'thread-goal-updated', threadId: 'thread-1', goal }, createdAt)
}

function agentStateWithPending(toolCallId: string): AgentState {
    return {
        requests: {
            [`${toolCallId}:request`]: {
                toolCallId,
                tool: 'Bash',
                arguments: { command: 'ls' },
                createdAt: 1
            }
        }
    } as unknown as AgentState
}

/** Drive the incremental reducer through successive window snapshots and
 *  return every intermediate result alongside the final state. */
function drive(
    snapshots: NormalizedMessage[][],
    agentState: AgentState | null | undefined = null
): { results: ReturnType<typeof reduceChatBlocks>[]; state: TailAppendReduceState | null } {
    let state: TailAppendReduceState | null = null
    const results: ReturnType<typeof reduceChatBlocks>[] = []
    for (const snapshot of snapshots) {
        const outcome = reduceChatBlocksWithTailAppend(state, {
            sessionId: SESSION,
            normalized: snapshot,
            agentState
        })
        state = outcome.state
        results.push(outcome.result)
    }
    return { results, state }
}

/** The fast path reuses prefix block objects; the full reduction always
 *  produces fresh ones. Used to assert which path a snapshot pair took. */
function tookFastPath(before: ReturnType<typeof reduceChatBlocks>, after: ReturnType<typeof reduceChatBlocks>): boolean {
    if (before.blocks.length === 0) return after.blocks.length > 0 ? after.blocks[0] !== undefined : true
    return after.blocks[0] === before.blocks[0]
}

describe('reduceChatBlocksWithTailAppend', () => {
    it('reuses prefix blocks for pure tail appends and matches the full reduction', () => {
        const base = [
            userMessage('u1', 'hello', 1),
            agentMessage('a1', [textPart('hi there', 'uuid-1')], 2),
            userMessage('u2', 'again', 3)
        ]
        const appended = [
            agentMessage('a2', [textPart('answer', 'uuid-2')], 4),
            eventMessage('e1', { type: 'message', message: 'working' }, 5),
            userMessage('u3', 'thanks', 6)
        ]
        const snapshots = [base, [...base, ...appended]]
        const { results, state } = drive(snapshots)

        const fast = results[1]
        const full = reduceChatBlocks([...base, ...appended], null)
        expect(fast).toEqual(full)
        expect(state?.normalized).toHaveLength(base.length + appended.length)
        expect(tookFastPath(results[0], fast)).toBe(true)
        // Prefix block identity is preserved so downstream reconciliation
        // keeps component state stable.
        expect(fast.blocks.length).toBeGreaterThan(results[0].blocks.length)
        for (let index = 0; index < results[0].blocks.length; index += 1) {
            expect(fast.blocks[index]).toBe(results[0].blocks[index])
        }
    })

    it('appends new tool calls without touching the prefix', () => {
        const base = [
            userMessage('u1', 'run it', 1),
            agentMessage('a1', [toolCallPart('call-1')], 2)
        ]
        const appended = [
            agentMessage('a2', [textPart('thinking', 'uuid-2'), toolCallPart('call-2', 'Read', { path: '/f' })], 3),
            eventMessage('e1', { type: 'ready' }, 4)
        ]
        const { results } = drive([base, [...base, ...appended]])

        expect(results[1]).toEqual(reduceChatBlocks([...base, ...appended], null))
        expect(results[1].hasReadyEvent).toBe(true)
        expect(results[0].hasReadyEvent).toBe(false)
    })

    it('falls back to the full reduction for appended tool results', () => {
        const base = [
            userMessage('u1', 'run', 1),
            agentMessage('a1', [toolCallPart('call-1')], 2)
        ]
        const appended = [agentMessage('a2', [toolResultPart('call-1')], 3)]
        const { results } = drive([base, [...base, ...appended]])

        expect(tookFastPath(results[0], results[1])).toBe(false)
        expect(results[1]).toEqual(reduceChatBlocks([...base, ...appended], null))
    })

    it('falls back when a re-sent tool call id would merge into a prefix block', () => {
        const base = [
            userMessage('u1', 'run', 1),
            agentMessage('a1', [toolCallPart('call-1')], 2)
        ]
        const appended = [agentMessage('a2', [toolCallPart('call-1')], 3)]
        const { results } = drive([base, [...base, ...appended]])

        expect(tookFastPath(results[0], results[1])).toBe(false)
        expect(results[1]).toEqual(reduceChatBlocks([...base, ...appended], null))
    })

    it('falls back when a repeated stream id would update a prefix block', () => {
        const base = [
            userMessage('u1', 'hi', 1),
            agentMessage('a1', [textPart('partial', 'uuid-1', 'stream-1')], 2)
        ]
        const appended = [agentMessage('a2', [textPart('partial full', 'uuid-2', 'stream-1')], 3)]
        const { results } = drive([base, [...base, ...appended]])

        expect(tookFastPath(results[0], results[1])).toBe(false)
        expect(results[1]).toEqual(reduceChatBlocks([...base, ...appended], null))
    })

    it('handles repeated stream ids that stay within one appended batch', () => {
        const base = [userMessage('u1', 'hi', 1)]
        const appended = [
            agentMessage('a1', [textPart('partial', 'uuid-1', 'stream-1')], 2),
            agentMessage('a2', [textPart('partial complete', 'uuid-2', 'stream-1')], 3)
        ]
        const built = drive([base, [...base, ...appended]])
        expect(tookFastPath(built.results[0], built.results[1])).toBe(true)
        expect(built.results[1]).toEqual(reduceChatBlocks([...base, ...appended], null))

        // A later batch repeating the same stream id must fall back to the
        // full reduction (it updates the earlier block in place).
        const grown = [...base, ...appended, agentMessage('a3', [textPart('more', 'uuid-3', 'stream-1')], 4)]
        const outcome = reduceChatBlocksWithTailAppend(built.state, {
            sessionId: SESSION,
            normalized: grown,
            agentState: null
        })
        expect(outcome.result).toEqual(reduceChatBlocks(grown, null))
    })

    it('falls back when the prefix is mutated rather than appended to', () => {
        const base = [
            userMessage('u1', 'hi', 1),
            agentMessage('a1', [textPart('draft', 'uuid-1')], 2)
        ]
        const replacedLast = [
            userMessage('u1', 'hi', 1),
            agentMessage('a1', [textPart('draft edited', 'uuid-1')], 2)
        ]
        const { results } = drive([base, replacedLast])

        expect(tookFastPath(results[0], results[1])).toBe(false)
        expect(results[1]).toEqual(reduceChatBlocks(replacedLast, null))
    })

    it('falls back when the agentState reference changes', () => {
        const base = [userMessage('u1', 'hi', 1)]
        const appended = [agentMessage('a1', [textPart('answer', 'uuid-1')], 2)]
        const agentStateA = {} as AgentState
        const agentStateB = {} as AgentState
        const first = drive([base], agentStateA)

        const outcome = reduceChatBlocksWithTailAppend(first.state, {
            sessionId: SESSION,
            normalized: [...base, ...appended],
            agentState: agentStateB
        })
        expect(outcome.result).toEqual(reduceChatBlocks([...base, ...appended], agentStateB))
    })

    it('falls back while the agent state has a pending permission request', () => {
        const base = [userMessage('u1', 'hi', 1)]
        const appended = [agentMessage('a1', [textPart('answer', 'uuid-1')], 2)]
        const state = agentStateWithPending('call-9')
        const { results } = drive([base, [...base, ...appended]], state)

        expect(results[1]).toEqual(reduceChatBlocks([...base, ...appended], state))
    })

    it('falls back for sidechain appends and goal-clearing sequences alike', () => {
        const base = [userMessage('u1', 'hi', 1)]
        const sidechainAppend = [{
            ...agentMessage('a1', [textPart('subagent work', 'uuid-1')], 2),
            isSidechain: true
        }]
        const { results } = drive([base, [...base, ...sidechainAppend]])
        expect(results[1]).toEqual(reduceChatBlocks([...base, ...sidechainAppend], null))

        const goalAppend = [goalMessage('g1', 'active', 3)]
        const second = drive([base, [...base, ...goalAppend]])
        expect(second.results[1]).toEqual(reduceChatBlocks([...base, ...goalAppend], null))
    })

    it('keeps goal state exact across fast-path appends', () => {
        const base = [userMessage('u1', 'hi', 1), goalMessage('g1', 'active', 2)]
        const appended = [
            agentMessage('a1', [textPart('answer', 'uuid-1')], 3),
            goalMessage('g2', 'complete', 4)
        ]
        const { results } = drive([base, [...base, ...appended]])

        const full = reduceChatBlocks([...base, ...appended], null)
        expect(results[1].latestGoal).toEqual(full.latestGoal)
        expect(results[1]).toEqual(full)
    })

    it('refreshes the goal from a changed goal source on an unchanged window', () => {
        const base = [userMessage('u1', 'hi', 1)]
        const first = drive([base])
        const goalSource: NormalizedMessage[] = [goalMessage('g1', 'active', 2)]

        const outcome = reduceChatBlocksWithTailAppend(first.state, {
            sessionId: SESSION,
            normalized: base,
            agentState: null,
            goalStateMessages: goalSource
        })
        expect(outcome.result.latestGoal).toEqual(reduceChatBlocks(base, null, {
            goalStateMessages: goalSource
        }).latestGoal)
        expect(outcome.result.blocks).toBe(first.results[0].blocks)
    })

    it('takes the latest usage from appended messages when present', () => {
        const base = [userMessage('u1', 'hi', 1)]
        const appended = [agentMessage('a1', [textPart('answer', 'uuid-1')], 2, {
            model: 'glm-5.3',
            usage: {
                input_tokens: 10,
                output_tokens: 5,
                context_tokens: 15,
                context_window: 200
            }
        })]
        const { results } = drive([base, [...base, ...appended]])

        const full = reduceChatBlocks([...base, ...appended], null)
        expect(results[1].latestUsage).toEqual(full.latestUsage)
        expect(results[1].latestUsage?.model).toBe('glm-5.3')
    })

    it('re-runs adjacency passes across the seam between prefix and appended blocks', () => {
        // Duplicate adjacent agent-event messages across the seam.
        const base = [
            userMessage('u1', 'hi', 1),
            eventMessage('e1', { type: 'message', message: 'working' }, 2)
        ]
        const appended = [eventMessage('e2', { type: 'message', message: 'working' }, 3)]
        const { results } = drive([base, [...base, ...appended]])

        const full = reduceChatBlocks([...base, ...appended], null)
        expect(results[1].blocks).toEqual(full.blocks)
        expect(results[1].blocks).toHaveLength(full.blocks.length)

        // Consecutive api-error events fold across the seam.
        const errorBase = [
            userMessage('u2', 'again', 10),
            eventMessage('ea', { type: 'api-error', retryAttempt: 1, maxRetries: 5, error: 'x' }, 11)
        ]
        const errorAppended = [
            eventMessage('eb', { type: 'api-error', retryAttempt: 2, maxRetries: 5, error: 'x' }, 12)
        ]
        const folded = drive([errorBase, [...errorBase, ...errorAppended]])
        const foldedFull = reduceChatBlocks([...errorBase, ...errorAppended], null)
        expect(folded.results[1].blocks).toEqual(foldedFull.blocks)
    })

    it('matches the full reduction across a mixed sequence of fast and fallback updates', () => {
        const u1 = userMessage('u1', 'start', 1)
        const a1 = agentMessage('a1', [textPart('first answer', 'uuid-1')], 2)
        const c1 = agentMessage('a2', [toolCallPart('call-1')], 3)
        const r1 = agentMessage('a3', [toolResultPart('call-1')], 4)
        const e1 = eventMessage('e1', { type: 'message', message: 'status' }, 5)
        const u2 = userMessage('u2', 'next', 6)
        const c2 = agentMessage('a4', [toolCallPart('call-2', 'Read', { path: '/x' })], 7)
        const r2 = agentMessage('a5', [toolResultPart('call-2', 'file contents')], 8)
        const a2 = agentMessage('a6', [textPart('final answer', 'uuid-6')], 9)

        const snapshots = [
            [u1],
            [u1, a1],
            [u1, a1, c1],
            [u1, a1, c1, r1],
            [u1, a1, c1, r1, e1],
            [u1, a1, c1, r1, e1, u2],
            [u1, a1, c1, r1, e1, u2, c2],
            [u1, a1, c1, r1, e1, u2, c2, r2],
            [u1, a1, c1, r1, e1, u2, c2, r2, a2]
        ]
        const { results } = drive(snapshots)

        for (let index = 0; index < snapshots.length; index += 1) {
            expect(results[index]).toEqual(reduceChatBlocks(snapshots[index], null))
        }
    })

    it('resets across sessions and falls back when the session id changes', () => {
        const base = [userMessage('u1', 'hi', 1)]
        const appended = [agentMessage('a1', [textPart('answer', 'uuid-1')], 2)]
        const first = drive([base, [...base, ...appended]])

        const outcome = reduceChatBlocksWithTailAppend(first.state, {
            sessionId: 'session-2',
            normalized: [userMessage('other-u1', 'other', 1)],
            agentState: null
        })
        expect(outcome.result).toEqual(reduceChatBlocks([userMessage('other-u1', 'other', 1)], null))
    })

    it('falls back for events that patch earlier blocks', () => {
        const base = [
            userMessage('u1', 'run', 1),
            agentMessage('a1', [toolCallPart('call-1')], 2)
        ]
        const durations = [
            eventMessage('d1', { type: 'turn-duration', durationMs: 1200 }, 3),
            eventMessage('t1', { type: 'token-count', info: {}, provider: 'codex' }, 4),
            eventMessage('s1', { type: 'turn-summary', summary: { modelUsage: {}, numTurns: 1 } }, 5)
        ]
        const { results } = drive([base, [...base, ...durations]])
        expect(results[1]).toEqual(reduceChatBlocks([...base, ...durations], null))
    })

    it('falls back when a later Task call would adopt prefix sidechain rows', () => {
        // The tracer attributes sidechain rows to a Task card by
        // parentToolUseId/prompt; the Task call can arrive *after* rows that
        // were previously unattributable in the prefix.
        const sidechainRow = {
            ...agentMessage('side-1', [textPart('subagent work', 'uuid-side')], 2),
            isSidechain: true,
            parentToolUseId: 'task-1'
        }
        const base = [userMessage('u1', 'delegate', 1), sidechainRow]
        const taskCall = agentMessage('a-task', [toolCallPart('task-1', 'Task', { prompt: 'do work' })], 3)
        const { results } = drive([base, [...base, taskCall]])

        expect(tookFastPath(results[0], results[1])).toBe(false)
        expect(results[1]).toEqual(reduceChatBlocks([...base, taskCall], null))
    })

    it('falls back when an appended tool call id matches an earlier result id', () => {
        // Result-before-call ordering: the result seeds the tool block first,
        // so the later call merges into it instead of creating a new card.
        const base = [
            userMessage('u1', 'run', 1),
            agentMessage('a1', [toolResultPart('call-late')], 2)
        ]
        const call = agentMessage('a2', [toolCallPart('call-late')], 3)
        const { results } = drive([base, [...base, call]])

        expect(tookFastPath(results[0], results[1])).toBe(false)
        expect(results[1]).toEqual(reduceChatBlocks([...base, call], null))
    })

    // Deterministic PRNG so failures reproduce.
    function mulberry32(seed: number): () => number {
        let a = seed >>> 0
        return () => {
            a = (a + 0x6d2b79f5) | 0
            let t = Math.imul(a ^ (a >>> 15), 1 | a)
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        }
    }

    it('stays byte-identical to the full reduction across randomized append sequences', () => {
        for (const seed of [0xc0ffee, 0xbeef, 0x5eed, 20261112]) {
            const random = mulberry32(seed)
            const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]
            let clock = 1

            const makeMessage = (index: number): NormalizedMessage => {
                const shape = random()
                const id = `m${index}`
                if (shape < 0.25) return userMessage(id, `user text ${index}`, clock++)
                if (shape < 0.55) {
                    const streamId = random() < 0.5 ? `stream-${Math.floor(random() * 4)}` : undefined
                    return agentMessage(id, [textPart(`agent text ${index}`, `${id}:uuid`, streamId)], clock++)
                }
                if (shape < 0.7) {
                    return agentMessage(id, [toolCallPart(`call-${Math.floor(random() * 6)}`, pick(['Bash', 'Read', 'Edit']))], clock++)
                }
                if (shape < 0.8) {
                    return agentMessage(id, [toolResultPart(`call-${Math.floor(random() * 6)}`)], clock++)
                }
                if (shape < 0.9) return eventMessage(id, { type: 'message', message: `status ${index}` }, clock++)
                return eventMessage(id, { type: 'api-error', retryAttempt: 1, maxRetries: 3, error: 'boom' }, clock++)
            }

            let window: NormalizedMessage[] = []
            let state: TailAppendReduceState | null = null
            let messageIndex = 0
            // ~40 batches of 1-6 random rows, mixing fast-path-safe and
            // fallback-triggering shapes (tool results, duplicate call/stream ids).
            for (let batch = 0; batch < 40; batch += 1) {
                const additions = Array.from(
                    { length: 1 + Math.floor(random() * 6) },
                    () => makeMessage(messageIndex++)
                )
                window = [...window, ...additions]
                const outcome = reduceChatBlocksWithTailAppend(state, {
                    sessionId: SESSION,
                    normalized: window,
                    agentState: null
                })
                state = outcome.state
                expect(outcome.result).toEqual(reduceChatBlocks(window, null))
            }
        }
    })
})
