import { describe, expect, it } from 'vitest'
import { aggregateResponseGroups } from './assistant-runtime'
import type { AgentEventBlock, AgentTextBlock, CliOutputBlock, ToolCallBlock, UserTextBlock } from '@/chat/types'
import type { ToolGroupBlock, VisibleChatBlock } from '@/chat/toolGroups'

// Minimal builders for VisibleChatBlock fixtures. Tests focus on metadata
// aggregation behavior across response groups; non-metadata fields default to
// inert values.

function userText(id: string, overrides: Partial<UserTextBlock> = {}): UserTextBlock {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt: 0,
        text: '',
        ...overrides
    }
}

function agentText(id: string, overrides: Partial<AgentTextBlock> = {}): AgentTextBlock {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 0,
        text: '',
        ...overrides
    }
}

function toolCall(id: string, overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 0,
        tool: {
            id,
            name: 'Read',
            state: 'completed',
            input: {},
            createdAt: 0,
            startedAt: null,
            completedAt: null,
            description: null
        },
        children: [],
        ...overrides
    }
}

function agentEvent(id: string, event: AgentEventBlock['event']): AgentEventBlock {
    return {
        kind: 'agent-event',
        id,
        createdAt: 0,
        event
    }
}

function cliOutput(id: string, source: CliOutputBlock['source'], overrides: Partial<CliOutputBlock> = {}): CliOutputBlock {
    return {
        kind: 'cli-output',
        id,
        localId: null,
        createdAt: 0,
        text: '',
        source,
        ...overrides
    }
}

describe('aggregateResponseGroups', () => {
    it('1. sums usage and dedups model across distinct localIds in a single response group', () => {
        // user (no aggregate) → agent-text L1 → tool-call L1 → tool-call L2 → agent-text L3
        // 3 distinct turns. Group's first visible block is the agent-text at L1.
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            agentText('a1', {
                localId: 'L1',
                invokedAt: 100,
                durationMs: 1234,
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 10, output_tokens: 20, service_tier: 'standard' }
            }),
            toolCall('t1', { localId: 'L1' }),
            toolCall('t2', {
                localId: 'L2',
                invokedAt: 200,
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 5, output_tokens: 7, service_tier: 'standard' }
            }),
            agentText('a3', {
                localId: 'L3',
                invokedAt: 300,
                durationMs: 5678,
                model: 'claude-haiku-4-5-20251001',
                usage: { input_tokens: 3, output_tokens: 11, service_tier: 'standard' }
            })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        const meta = aggregates.get('a1')
        expect(meta).toBeDefined()
        expect(meta?.turnCount).toBe(3)
        // input/output sums across the three distinct localIds.
        expect(meta?.usage?.input_tokens).toBe(10 + 5 + 3)
        expect(meta?.usage?.output_tokens).toBe(20 + 7 + 11)
        // Model dedup preserves first-seen order. "claude-sonnet-4-6" appears
        // twice (L1, L2) and must not be duplicated.
        expect(meta?.model).toBe('claude-sonnet-4-6, claude-haiku-4-5-20251001')
        // Invoke time = first turn (regression guard for the user-reported
        // disappearance after PR #555).
        expect(meta?.invokedAt).toBe(100)
        // Duration is intentionally undefined so the library does not surface
        // the first turn's stale duration on the aggregated card.
        expect(meta?.durationMs).toBeUndefined()
        // Only the group's first visible block carries an aggregate entry.
        expect(aggregates.has('u1')).toBe(false)
        expect(aggregates.has('t1')).toBe(false)
        expect(aggregates.has('t2')).toBe(false)
        expect(aggregates.has('a3')).toBe(false)
    })

    it('2. leaves a single-turn group untouched so the existing footer renders unchanged', () => {
        // localId 'L1' shared across multiple blocks → still one turn.
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            agentText('a1', {
                localId: 'L1',
                invokedAt: 42,
                durationMs: 999,
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 3, output_tokens: 19, service_tier: 'standard' }
            }),
            toolCall('t1', { localId: 'L1' })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        // No entry → upstream callback emits the original per-block metadata.
        expect(aggregates.size).toBe(0)
    })

    it('3. splits response groups on each user-text boundary', () => {
        // user → agent L1 → tool L1 → user → agent L2 → agent L3
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            agentText('a1', {
                localId: 'L1',
                invokedAt: 100,
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 10, output_tokens: 20, service_tier: 'standard' }
            }),
            toolCall('t1', { localId: 'L1' }),
            userText('u2'),
            agentText('a2', {
                localId: 'L2',
                invokedAt: 200,
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 4, output_tokens: 8, service_tier: 'standard' }
            }),
            agentText('a3', {
                localId: 'L3',
                invokedAt: 300,
                model: 'claude-haiku-4-5-20251001',
                usage: { input_tokens: 5, output_tokens: 7, service_tier: 'standard' }
            })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        // First group is a single turn → no entry.
        expect(aggregates.has('a1')).toBe(false)
        // Second group spans L2 + L3, first visible block is a2.
        const meta2 = aggregates.get('a2')
        expect(meta2?.turnCount).toBe(2)
        expect(meta2?.usage?.input_tokens).toBe(9)
        expect(meta2?.usage?.output_tokens).toBe(15)
        expect(meta2?.model).toBe('claude-sonnet-4-6, claude-haiku-4-5-20251001')
        expect(meta2?.invokedAt).toBe(200)
    })

    it('4. preserves first-seen order when dedup yields two distinct models in one group', () => {
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            agentText('a1', {
                localId: 'L1',
                invokedAt: 100,
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 1, output_tokens: 1, service_tier: 'standard' }
            }),
            agentText('a2', {
                localId: 'L2',
                invokedAt: 200,
                model: 'claude-haiku-4-5-20251001',
                usage: { input_tokens: 1, output_tokens: 1, service_tier: 'standard' }
            })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        const meta = aggregates.get('a1')
        expect(meta?.model).toBe('claude-sonnet-4-6, claude-haiku-4-5-20251001')
    })

    it('5. falls back to a (model, usage) fingerprint to count turns when localId is null', () => {
        // Claude code spawn sessions today never stamp `localId`; all
        // blocks emitted in one Claude SDK message carry an identical
        // `usage` object instead. We dedup by that fingerprint so a
        // single turn does not over-count when its blocks repeat.
        const turn1Usage = { input_tokens: 1, output_tokens: 2, service_tier: 'standard' as const }
        const turn2Usage = { input_tokens: 4, output_tokens: 8, service_tier: 'standard' as const }
        const turn3Usage = { input_tokens: 16, output_tokens: 32, service_tier: 'standard' as const }
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            // turn 1: thinking + tool_use share one usage object
            agentText('a1', { localId: null, invokedAt: 100, model: 'claude-sonnet-4-6', usage: turn1Usage }),
            toolCall('t1', { localId: null, invokedAt: 105, model: 'claude-sonnet-4-6', usage: turn1Usage }),
            // turn 2: a different usage object -> new turn
            agentText('a2', { localId: null, invokedAt: 200, model: 'claude-sonnet-4-6', usage: turn2Usage }),
            // turn 3: a different model + usage -> new turn
            agentText('a3', { localId: null, invokedAt: 300, model: 'claude-haiku-4-5-20251001', usage: turn3Usage })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        const meta = aggregates.get('a1')
        expect(meta?.turnCount).toBe(3)
        // sum across the three distinct turns
        expect(meta?.usage?.input_tokens).toBe(21)
        expect(meta?.usage?.output_tokens).toBe(42)
        expect(meta?.model).toBe('claude-sonnet-4-6, claude-haiku-4-5-20251001')
    })

    it("5b. skips chunk blocks without model or usage so they do not inflate the turn count", () => {
        // hapi's hub stores tool_result chunks as separate agent-role
        // messages with no `model`, no `usage`, and `localId=null`.
        // They share an SDK turn with the preceding tool_use but the
        // fingerprint signal is missing, so the aggregator must skip
        // them rather than inflate the turn count.
        const turn1Usage = { input_tokens: 3, output_tokens: 8, service_tier: 'standard' as const }
        const turn2Usage = { input_tokens: 1, output_tokens: 5, service_tier: 'standard' as const }
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            agentText('a1', { localId: null, invokedAt: 100, model: 'claude-sonnet-4-6', usage: turn1Usage }),
            toolCall('t1', { localId: null, invokedAt: 101, model: 'claude-sonnet-4-6', usage: turn1Usage }),
            // tool_result chunk: no model, no usage
            agentText('a2_result', { localId: null, invokedAt: 102 }),
            // final turn with a different usage
            agentText('a3_final', { localId: null, invokedAt: 200, model: 'claude-sonnet-4-6', usage: turn2Usage })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        const meta = aggregates.get('a1')
        expect(meta?.turnCount).toBe(2)
        expect(meta?.usage?.input_tokens).toBe(4)
        expect(meta?.usage?.output_tokens).toBe(13)
    })

    it('6. ends a response group at an agent-event boundary (library chunk flush)', () => {
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            agentText('a1', {
                localId: 'L1',
                invokedAt: 100,
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 10, output_tokens: 20, service_tier: 'standard' }
            }),
            // limit-reached splits the library's chunk; the next assistant
            // block starts a new card and therefore a new response group.
            agentEvent('e1', { type: 'limit-reached', endsAt: 0, limitType: '5h' }),
            agentText('a2', {
                localId: 'L2',
                invokedAt: 200,
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 4, output_tokens: 8, service_tier: 'standard' }
            }),
            agentText('a3', {
                localId: 'L3',
                invokedAt: 300,
                model: 'claude-haiku-4-5-20251001',
                usage: { input_tokens: 1, output_tokens: 1, service_tier: 'standard' }
            })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        // Pre-event group is a single turn → no entry.
        expect(aggregates.has('a1')).toBe(false)
        // Post-event group has two turns starting at a2.
        const meta2 = aggregates.get('a2')
        expect(meta2?.turnCount).toBe(2)
        expect(meta2?.invokedAt).toBe(200)
        expect(meta2?.usage?.input_tokens).toBe(5)
        expect(meta2?.usage?.output_tokens).toBe(9)
    })

    it('does not aggregate user-role cli-output blocks (they do not belong to a response group)', () => {
        // Defensive: a cli-output with source='user' is rendered as a user
        // role message by the converter, so it must not be folded into an
        // assistant response group nor act as the group's first block.
        const blocks: VisibleChatBlock[] = [
            cliOutput('c1', 'user'),
            agentText('a1', {
                localId: 'L1',
                invokedAt: 100,
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 1, output_tokens: 2, service_tier: 'standard' }
            }),
            agentText('a2', {
                localId: 'L2',
                invokedAt: 200,
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 3, output_tokens: 4, service_tier: 'standard' }
            })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        expect(aggregates.has('c1')).toBe(false)
        // a1 is the first visible block of the response group spanning L1+L2.
        const meta = aggregates.get('a1')
        expect(meta?.turnCount).toBe(2)
    })

    it('does not surface cache_read/cache_creation tokens via aggregation (sums them but display ignores)', () => {
        // We still sum every UsageData field so the aggregate is structurally
        // complete, but the visible label only consumes input/output. This
        // lets future surfaces decide independently.
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            agentText('a1', {
                localId: 'L1',
                invokedAt: 100,
                model: 'claude-sonnet-4-6',
                usage: {
                    input_tokens: 1,
                    output_tokens: 2,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 50,
                    service_tier: 'standard'
                }
            }),
            agentText('a2', {
                localId: 'L2',
                invokedAt: 200,
                model: 'claude-sonnet-4-6',
                usage: {
                    input_tokens: 3,
                    output_tokens: 4,
                    cache_creation_input_tokens: 200,
                    cache_read_input_tokens: 50,
                    service_tier: 'standard'
                }
            })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        const meta = aggregates.get('a1')
        expect(meta?.usage?.cache_creation_input_tokens).toBe(300)
        expect(meta?.usage?.cache_read_input_tokens).toBe(100)
    })
})
