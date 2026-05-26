import { describe, expect, it } from 'vitest'
import { aggregateResponseGroups, buildPluginMessageActionRequest } from './assistant-runtime'
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

function toolGroup(id: string, tools: ToolCallBlock[], overrides: Partial<ToolGroupBlock> = {}): ToolGroupBlock {
    return {
        kind: 'tool-group',
        id,
        createdAt: 0,
        invokedAt: tools[0]?.invokedAt ?? null,
        firstToolId: tools[0]?.id ?? id,
        lastToolId: tools[tools.length - 1]?.id ?? id,
        tools,
        defaultOpen: false,
        historyState: 'complete',
        needsOlderHistory: false,
        summary: {
            totalTools: tools.length,
            countsByKind: { read: 0, search: 0, command: 0, mutation: 0, web: 0, other: 0 },
            fileTargets: [],
            commandTargets: [],
            searchTargets: [],
            urlTargets: [],
            otherTargets: [],
            errorCount: 0,
            runningCount: 0,
            pendingCount: 0
        },
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

    it('5a. fingerprint dedup is ordering-based: identical adjacent blocks count as one turn, identical non-adjacent blocks count as separate turns', () => {
        // Each Claude SDK message emits multiple blocks that share an
        // identical usage object — adjacent blocks must collapse to one
        // turn. But two distinct SDK messages occasionally happen to
        // produce the same (model, usage) fingerprint when separated by
        // a third turn with different totals. A Set-based dedup would
        // collapse those non-adjacent matches into one turn and under-
        // count; an ordering-based dedup only merges adjacent matches.
        const sharedUsage = { input_tokens: 5, output_tokens: 7, service_tier: 'standard' as const }
        const middleUsage = { input_tokens: 11, output_tokens: 13, service_tier: 'standard' as const }
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            // Turn 1 emits two blocks sharing the same usage fingerprint.
            agentText('a1', { localId: null, invokedAt: 100, model: 'claude-sonnet-4-6', usage: sharedUsage }),
            toolCall('t1', { localId: null, invokedAt: 101, model: 'claude-sonnet-4-6', usage: sharedUsage }),
            // Turn 2: different fingerprint.
            agentText('a2', { localId: null, invokedAt: 200, model: 'claude-sonnet-4-6', usage: middleUsage }),
            // Turn 3 happens to repeat turn 1's (model, usage) fingerprint.
            agentText('a3', { localId: null, invokedAt: 300, model: 'claude-sonnet-4-6', usage: sharedUsage })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        const meta = aggregates.get('a1')
        // Three distinct turns: adjacent fingerprint match collapses (a1+t1),
        // non-adjacent fingerprint match does not (a1 vs a3).
        expect(meta?.turnCount).toBe(3)
        // Sum: shared + middle + shared.
        expect(meta?.usage?.input_tokens).toBe(5 + 11 + 5)
        expect(meta?.usage?.output_tokens).toBe(7 + 13 + 7)
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

    it('counts a tool-group whose tools all belong to a single turn as one turn', () => {
        // `buildVisibleChatBlocks` merges adjacent eligible tool-calls into a
        // single `tool-group` block. When every underlying tool shares one
        // turn (same localId, same usage), the aggregator must collapse them
        // to one turn — the group is not its own turn boundary.
        const turn1Usage = { input_tokens: 7, output_tokens: 11, service_tier: 'standard' as const }
        const turn2Usage = { input_tokens: 2, output_tokens: 9, service_tier: 'standard' as const }
        const tool1 = toolCall('t1', { localId: 'L1', invokedAt: 100, model: 'claude-sonnet-4-6', usage: turn1Usage })
        const tool2 = toolCall('t2', { localId: 'L1', invokedAt: 105, model: 'claude-sonnet-4-6', usage: turn1Usage })
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            toolGroup('g1', [tool1, tool2]),
            agentText('a1', {
                localId: 'L2',
                invokedAt: 200,
                model: 'claude-sonnet-4-6',
                usage: turn2Usage
            })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        // g1 is the group's first visible block.
        const meta = aggregates.get('g1')
        expect(meta?.turnCount).toBe(2)
        // input/output sums across the tool-group turn and the agent-text turn.
        expect(meta?.usage?.input_tokens).toBe(7 + 2)
        expect(meta?.usage?.output_tokens).toBe(11 + 9)
        expect(meta?.invokedAt).toBe(100)
    })

    it('skips an empty tool-group block without throwing or inflating the turn count', () => {
        // Defensive: a malformed tool-group with zero tools must degrade to
        // null rather than crash. The surrounding response group continues.
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            toolGroup('g0', []),
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
        // g0 is the first visible block of the response group (no entry — the
        // empty group contributes no turn, and the boundary remains at the
        // user block).
        const meta = aggregates.get('g0')
        expect(meta?.turnCount).toBe(2)
        expect(meta?.usage?.input_tokens).toBe(4)
        expect(meta?.usage?.output_tokens).toBe(6)
    })

    it('counts every turn inside a tool-group that spans multiple assistant turns', () => {
        // Regression guard for the case the helper expands: a single
        // `tool-group` block may wrap tool-calls from two distinct turns.
        const turn1Usage = { input_tokens: 7, output_tokens: 11, service_tier: 'standard' as const }
        const turn2Usage = { input_tokens: 2, output_tokens: 9, service_tier: 'standard' as const }
        const tool1 = toolCall('t1', { localId: 'L1', invokedAt: 100, model: 'claude-sonnet-4-6', usage: turn1Usage })
        const tool2 = toolCall('t2', { localId: 'L2', invokedAt: 110, model: 'claude-haiku-4-5-20251001', usage: turn2Usage })
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            toolGroup('g1', [tool1, tool2])
        ]

        const aggregates = aggregateResponseGroups(blocks)
        const meta = aggregates.get('g1')
        expect(meta?.turnCount).toBe(2)
        expect(meta?.usage?.input_tokens).toBe(7 + 2)
        expect(meta?.usage?.output_tokens).toBe(11 + 9)
        expect(meta?.model).toBe('claude-sonnet-4-6, claude-haiku-4-5-20251001')
        expect(meta?.invokedAt).toBe(100)
    })

    it('keeps two fingerprint-mode turns distinct when only token totals coincide (different createdAt)', () => {
        // Two consecutive SDK messages happen to report identical
        // `(model, usage)` (rare but possible on very short turns). Different
        // createdAt values keep their fingerprints distinct so the aggregator
        // counts both turns instead of dedupping them.
        const usage = { input_tokens: 3, output_tokens: 5, service_tier: 'standard' as const }
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            agentText('a1', { localId: null, createdAt: 1000, invokedAt: 100, model: 'claude-sonnet-4-6', usage }),
            agentText('a2', { localId: null, createdAt: 2000, invokedAt: 200, model: 'claude-sonnet-4-6', usage })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        const meta = aggregates.get('a1')
        expect(meta?.turnCount).toBe(2)
        expect(meta?.usage?.input_tokens).toBe(3 + 3)
        expect(meta?.usage?.output_tokens).toBe(5 + 5)
    })

    it('preserves a 0 sum on cache token fields instead of folding it to undefined', () => {
        // Both turns omit cache_creation/cache_read entirely. The aggregator
        // must not invent a 0 either — the field remains undefined when no
        // turn carried a value. Conversely, if one turn reports 0 explicitly
        // we keep 0 in the sum (covered by the next case).
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
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
        const meta = aggregates.get('a1')
        expect(meta?.usage?.cache_creation_input_tokens).toBeUndefined()
        expect(meta?.usage?.cache_read_input_tokens).toBeUndefined()
    })

    it('keeps an explicit 0 in a cache token sum (does not coerce 0 → undefined via ||)', () => {
        // Regression for the `(a ?? 0) + (b ?? 0) || undefined` pattern:
        // 0 + 0 must remain 0 when at least one turn carried the field
        // explicitly, otherwise downstream surfaces lose the signal.
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            agentText('a1', {
                localId: 'L1',
                invokedAt: 100,
                model: 'claude-sonnet-4-6',
                usage: {
                    input_tokens: 1,
                    output_tokens: 2,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
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
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    service_tier: 'standard'
                }
            })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        const meta = aggregates.get('a1')
        expect(meta?.usage?.cache_creation_input_tokens).toBe(0)
        expect(meta?.usage?.cache_read_input_tokens).toBe(0)
    })

    it('keeps a partial cache token value when only one turn carries it', () => {
        // The other turn contributes 0 (treated as the missing-side default)
        // and the sum equals the side that did carry a value.
        const blocks: VisibleChatBlock[] = [
            userText('u1'),
            agentText('a1', {
                localId: 'L1',
                invokedAt: 100,
                model: 'claude-sonnet-4-6',
                usage: {
                    input_tokens: 1,
                    output_tokens: 2,
                    cache_creation_input_tokens: 50,
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
                    service_tier: 'standard'
                }
            })
        ]

        const aggregates = aggregateResponseGroups(blocks)
        const meta = aggregates.get('a1')
        expect(meta?.usage?.cache_creation_input_tokens).toBe(50)
        expect(meta?.usage?.cache_read_input_tokens).toBeUndefined()
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

describe('buildPluginMessageActionRequest', () => {
    it('builds a pluginAction request from a ready composer action descriptor', () => {
        expect(buildPluginMessageActionRequest({
            id: 'cross',
            kind: 'pluginMessageAction',
            pluginId: 'com.example.cross',
            capabilityId: 'cross-capability',
            label: 'Cross',
            icon: 'clock',
            handler: { position: 'hub', actionId: 'cross-handler' },
            ui: { kind: 'button' }
        }, { value: 1 })).toEqual({
            pluginId: 'com.example.cross',
            capabilityId: 'cross-capability',
            position: 'hub',
            actionId: 'cross-handler',
            payload: { value: 1 }
        })
    })
})
