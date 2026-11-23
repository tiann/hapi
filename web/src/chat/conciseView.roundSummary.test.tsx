import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { filterConciseChatBlocks } from './conciseView'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import { reconcileChatBlocks, type ChatBlocksById } from './reconcile'
import { buildVisibleChatBlocks } from './toolGroups'
import type { AgentEvent, ChatBlock, NormalizedMessage } from './types'
import { aggregateResponseGroups, assignThreadMessageIds, buildSourceMessageIdsByBlock } from '@/lib/assistant-runtime'
import { buildMessageMetadataLabels, MessageMetadata } from '@/components/AssistantChat/messages/MessageMetadata'

const wireSummary = {
    usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { 'fixture/model': { inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    total_cost_usd: 0.02, num_turns: 2, duration_ms: 9000,
    generation_ms: 1500, generation_output_tokens: 30
}
function carrier(prefix: string, summary = wireSummary): NormalizedMessage {
    const message = normalizeDecryptedMessage({
        id: `${prefix}-summary`, seq: 9, localId: null, createdAt: 9,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'round-summary', summary } } }
    })
    if (!message) throw new Error('Invalid test summary carrier')
    return message
}
function user(id: string): NormalizedMessage {
    return { id, localId: null, createdAt: 1, role: 'user', isSidechain: false, content: { type: 'text', text: id } }
}
function text(id: string, kind: 'text' | 'reasoning' = 'text', turnId?: string): NormalizedMessage {
    return { id, localId: null, createdAt: 3, role: 'agent', isSidechain: false,
        meta: turnId ? { codexTurnId: turnId } : undefined,
        content: [{ type: kind, text: id, uuid: id, streamId: id, parentUUID: null }] }
}
function tool(id: string, name = 'Read'): NormalizedMessage {
    return { id, localId: null, createdAt: 2, role: 'agent', isSidechain: false,
        content: [{ type: 'tool-call', id, name, input: {}, description: null, uuid: id, parentUUID: null }] }
}
function event(id: string, content: AgentEvent): NormalizedMessage {
    return { id, localId: null, createdAt: 4, role: 'event', isSidechain: false, content }
}
function round(prefix: string, first: 'tool' | 'reasoning' | 'narration' = 'tool', summary = wireSummary): NormalizedMessage[] {
    const work = first === 'tool' ? [tool(`${prefix}-tool`)]
        : first === 'reasoning' ? [text(`${prefix}-reason`, 'reasoning')]
            : [text(`${prefix}-narration`), tool(`${prefix}-tool`)]
    return [user(`${prefix}-user`), ...work, text(`${prefix}-final`), carrier(prefix, summary), event(`${prefix}-ready`, { type: 'ready' })]
}
function project(blocks: ChatBlock[], concise = true) {
    const projected = concise ? filterConciseChatBlocks(blocks) : blocks
    const visible = buildVisibleChatBlocks(projected, { hasMoreMessages: false })
    const aggregates = aggregateResponseGroups(visible)
    const labels = [...aggregates.values()].map(meta => buildMessageMetadataLabels(meta))
    const rendered = [...aggregates.values()].map(meta => renderToStaticMarkup(createElement(MessageMetadata, meta))).join('')
    return { projected, visible, aggregates, labels, rendered }
}
function pipeline(messages: NormalizedMessage[], previous: ChatBlocksById = new Map()) {
    const reconciled = reconcileChatBlocks(reduceChatBlocks(messages, null).blocks, previous)
    return { ...project(reconciled.blocks), canonical: reconciled.blocks, byId: reconciled.byId }
}
function freeze(blocks: readonly ChatBlock[]): void {
    for (const block of blocks) {
        if (block.kind === 'tool-call') { freeze(block.children); Object.freeze(block.tool); Object.freeze(block.children) }
        Object.freeze(block)
    }
    Object.freeze(blocks)
}

describe('concise summary through reducer, reconcile, grouping and runtime metadata', () => {
    it.each(['tool', 'reasoning', 'narration'] as const)('preserves the whole common summary from hidden %s on the retained final reply', first => {
        const result = pipeline(round('one', first))
        expect(result.projected.map(block => block.kind)).toEqual(['user-text', 'agent-text'])
        expect(result.labels).toEqual([['Model: fixture/model', 'Tokens: 130 (100 in · 30 out)', 'Cost: $0.020', 'Round: 9s · 2 turns · 20.0 tok/s']])
        expect(result.rendered).toContain('20.0 tok/s')
        const original = result.canonical.find(block => block.kind === 'agent-text' && block.text === 'one-final')
        const final = result.projected[1]
        expect(final.id).toBe(original?.id)
        expect(final.kind === 'agent-text' ? final.sourceMessageIds : null).toEqual(original?.kind === 'agent-text' ? original.sourceMessageIds : null)
        const source = result.canonical.find(block => 'roundSummary' in block)
        const canonicalSummary = source && 'roundSummary' in source ? source.roundSummary : undefined
        expect('roundSummary' in final ? final.roundSummary : undefined).toBe(canonicalSummary)
    })

    it('reacts to late S and each generation field change/removal through reconciliation', () => {
        const messages = round('late')
        let result = pipeline(messages.filter(message => message.id !== 'late-summary'))
        expect(result.rendered).not.toContain('tok/s')
        for (const summary of [wireSummary,
            { ...wireSummary, generation_ms: 750 },
            { ...wireSummary, generation_output_tokens: 60 },
            { ...wireSummary, generation_ms: undefined },
            { ...wireSummary, generation_output_tokens: undefined },
            wireSummary]) {
            result = pipeline(round('late', 'tool', summary as typeof wireSummary), result.byId)
            const hasPair = summary.generation_ms !== undefined && summary.generation_output_tokens !== undefined
            const expected = hasPair ? `${(summary.generation_output_tokens! / (summary.generation_ms! / 1000)).toFixed(1)} tok/s` : null
            if (expected) expect(result.rendered).toContain(expected)
            else expect(result.rendered).not.toContain('tok/s')
            expect(result.rendered).toContain('Cost: $0.020')
            expect(result.rendered).toContain('Round: 9s')
        }
        result = pipeline(messages.filter(message => message.id !== 'late-summary'), result.byId)
        expect(result.rendered).not.toContain('tok/s')
        expect(result.aggregates.size).toBe(0)
    })

    it('toggles off/on without mutating canonical blocks or changing final source/message IDs', () => {
        const { canonical } = pipeline(round('toggle'))
        const before = JSON.stringify(canonical)
        freeze(canonical)
        const off = project(canonical, false)
        const on = project(canonical)
        const offAgain = project(canonical, false)
        const onAgain = project(canonical)
        expect(off.projected).toBe(canonical)
        expect(offAgain.projected).toBe(canonical)
        expect(on.labels).toEqual(off.labels)
        expect(onAgain.labels).toEqual(on.labels)
        expect(JSON.stringify(canonical)).toBe(before)
        const sources = buildSourceMessageIdsByBlock(on.visible)
        const final = on.visible[1]
        expect(sources.get(final)).toContain('toggle-final')
        expect(assignThreadMessageIds(on.visible).map(row => row.threadMessageId)).toEqual(assignThreadMessageIds(onAgain.visible).map(row => row.threadMessageId))
    })

    it('retains a visible interactive summary owner once rather than duplicating it onto final text', () => {
        const messages = round('interactive')
        messages[1] = tool('interactive-tool', 'AskUserQuestion')
        const result = pipeline(messages)
        expect(result.projected.map(block => block.kind)).toEqual(['user-text', 'tool-call', 'agent-text'])
        expect(result.projected.filter(block => 'roundSummary' in block && block.roundSummary)).toHaveLength(1)
        expect(result.labels.flat().filter(label => label.includes('tok/s'))).toHaveLength(1)
    })

    it('keeps summaries in their user rounds and does not duplicate them over multiple final text blocks', () => {
        const messages = round('first')
        messages.splice(3, 0, text('first-final-more'))
        const result = pipeline([...messages, ...round('second', 'reasoning', { ...wireSummary, generation_ms: 3000 })])
        expect(result.labels.flat().filter(label => label.includes('tok/s'))).toEqual(['Round: 9s · 2 turns · 20.0 tok/s', 'Round: 9s · 2 turns · 10.0 tok/s'])
        expect(result.projected.filter(block => 'roundSummary' in block && block.roundSummary)).toHaveLength(2)
    })

    it.each(['compact-summary', 'message', 'title-changed'] as const)('attaches a late summary to the latest canonical response after a %s boundary', type => {
        const boundary: AgentEvent = type === 'compact-summary'
            ? { type, summary: 'compacted', compactionId: 'compact-1' }
            : type === 'message' ? { type, message: 'separate response' } : { type, title: 'new title' }
        const result = pipeline([user('u'), tool('hidden'), event('boundary', boundary),
            text('other-final'), carrier('boundary')])
        expect(result.rendered).toContain('20.0 tok/s')
        const owner = result.canonical.filter(block => 'roundSummary' in block && block.roundSummary)
        expect(owner).toHaveLength(1)
        expect(owner[0]).toMatchObject({ kind: 'agent-text', text: 'other-final' })
        expect(result.projected.filter(block => 'roundSummary' in block && block.roundSummary)).toHaveLength(1)
    })

    it('keeps auto-compaction metadata on the post-compaction reply through late arrival, replay and toggles', () => {
        const normalize = (id: string, content: unknown): NormalizedMessage => {
            const message = normalizeDecryptedMessage({ id, seq: 4, localId: null, createdAt: 4, content })
            if (!message) throw new Error('Invalid auto-compaction fixture')
            return message
        }
        // Actual OpenCode native callbacks publish these two event shapes.
        const messages = [user('u'), tool('before-compact'),
            normalize('started', { role: 'agent', content: { type: 'event', data: { type: 'message', message: '📦 Compaction started' } } }),
            normalize('compact', { role: 'agent', content: { type: 'codex', data: { type: 'compact-summary', summary: 'compacted' } } }),
            text('post-compact-reason', 'reasoning'), text('post-compact-final'),
            event('title', { type: 'title-changed', title: 'done' })]
        let result = pipeline(messages)
        expect(result.rendered).not.toContain('tok/s')
        for (const summary of [wireSummary, { ...wireSummary, generation_ms: 750 },
            { ...wireSummary, generation_output_tokens: 60 },
            { ...wireSummary, generation_ms: undefined }, { ...wireSummary, generation_output_tokens: undefined }, wireSummary]) {
            result = pipeline([...messages, carrier('auto', summary as typeof wireSummary)], result.byId)
            const owners = result.canonical.filter(block => 'roundSummary' in block && block.roundSummary)
            expect(owners).toHaveLength(1)
            expect(owners[0]).toMatchObject({ kind: 'agent-reasoning', text: 'post-compact-reason' })
            expect(result.labels.flat()).toContain('Cost: $0.020')
            const paired = summary.generation_ms !== undefined && summary.generation_output_tokens !== undefined
            if (paired) expect(result.rendered).toContain(`${(summary.generation_output_tokens! / (summary.generation_ms! / 1000)).toFixed(1)} tok/s`)
            else expect(result.rendered).not.toContain('tok/s')
            const before = JSON.stringify(result.canonical)
            freeze(result.canonical)
            expect(project(result.canonical, false).labels).toEqual(result.labels)
            expect(project(result.canonical).labels).toEqual(result.labels)
            expect(JSON.stringify(result.canonical)).toBe(before)
            const final = result.visible.find(block => block.kind === 'agent-text')!
            expect(buildSourceMessageIdsByBlock(result.visible).get(final)).toEqual(['post-compact-final'])
            expect(assignThreadMessageIds(result.visible).find(row => row.block === final)?.threadMessageId).toBe(`agent-text:${final.id}`)
        }
        result = pipeline(messages, result.byId)
        expect(result.rendered).not.toContain('tok/s')
        expect(result.aggregates.size).toBe(0)
    })

    it.each(['compact-summary', 'message'] as const)('does not transfer an earlier summary across a later %s boundary', type => {
        const result = pipeline([user('u'), tool('hidden'), carrier('earlier'), event('boundary', type === 'compact-summary'
            ? { type, summary: 'compacted' } : { type, message: 'separate response' }), text('other-final')])
        expect(result.rendered).not.toContain('tok/s')
        expect(result.projected.filter(block => 'roundSummary' in block && block.roundSummary)).toHaveLength(0)
    })

    it.each(['user', 'cli-user'] as const)('does not search past a newer %s with only trailing events', boundary => {
        const next = user('next')
        if (boundary === 'cli-user') {
            next.meta = { sentFrom: 'cli' }
            next.content = { type: 'text', text: '<command-name>/help</command-name>' }
        }
        const result = pipeline([user('u'), text('old-final'), next,
            event('notice', { type: 'message', message: 'no new reply' }), carrier('unowned')])
        expect(result.canonical.some(block => 'roundSummary' in block && block.roundSummary)).toBe(false)
        expect(result.rendered).not.toContain('tok/s')
    })

    it('preserves separate summaries and a single visible interactive owner after compaction', () => {
        const result = pipeline([user('u'), tool('before', 'AskUserQuestion'), carrier('before'),
            event('started', { type: 'message', message: '📦 Compaction started' }),
            event('compact', { type: 'compact-summary', summary: 'compacted' }), tool('after', 'AskUserQuestion'),
            text('final'), carrier('after', { ...wireSummary, generation_ms: 3000 })])
        expect(result.canonical.filter(block => 'roundSummary' in block && block.roundSummary)).toHaveLength(2)
        expect(result.projected.filter(block => 'roundSummary' in block && block.roundSummary)).toHaveLength(2)
        expect(result.labels.flat().filter(label => label.includes('tok/s'))).toEqual([
            'Round: 9s · 2 turns · 20.0 tok/s', 'Round: 9s · 2 turns · 10.0 tok/s'])
    })

    it('preserves the legacy Claude summary contract on the post-event response without inventing TPS', () => {
        const legacy = normalizeDecryptedMessage({ id: 'claude-summary', seq: 9, localId: null, createdAt: 9,
            content: { role: 'agent', content: { type: 'output', data: { type: 'system', subtype: 'turn_duration',
                resultSummary: { modelUsage: wireSummary.modelUsage, total_cost_usd: 0.02, num_turns: 2, duration_ms: 9000 } } } } })
        if (!legacy) throw new Error('Invalid legacy Claude carrier')
        const result = pipeline([user('u'), tool('hidden'), event('compact', { type: 'compact-summary', summary: 'compacted' }),
            text('claude-final'), legacy])
        expect(result.labels.flat()).toContain('Round: 9s · 2 turns')
        expect(result.rendered).not.toContain('tok/s')
        expect(result.canonical.filter(block => 'roundSummary' in block && block.roundSummary)).toEqual([
            expect.objectContaining({ kind: 'agent-text', text: 'claude-final' })])
    })

    it('does not borrow a summary from a distinct native response owner', () => {
        const a = text('old-reason', 'reasoning', 'response-a')
        const b = text('new-final', 'text', 'response-b')
        const result = pipeline([user('u'), a, b, carrier('owners')])
        expect(result.rendered).not.toContain('tok/s')
    })

    it('does not invent an empty reply or borrow a following user round when no target survives', () => {
        const result = pipeline([user('first'), tool('hidden'), carrier('empty'), user('second'), text('second-final')])
        expect(result.projected.map(block => block.kind)).toEqual(['user-text', 'user-text', 'agent-text'])
        expect(result.rendered).not.toContain('tok/s')
    })

    it('leaves conflicting summary carriers untouched and does not choose or merge one into the reply', () => {
        // Defensive projection input: two canonical carriers cannot identify one round owner.
        const left = reduceChatBlocks(round('left', 'reasoning'), null).blocks
        const right = reduceChatBlocks(round('right', 'tool', { ...wireSummary, generation_ms: 3000 }), null).blocks
        const inputs = [left[0], left[1], right[1], left[2]]
        const canonical = reconcileChatBlocks(inputs, new Map()).blocks
        const before = JSON.stringify(canonical)
        const result = project(canonical)
        expect(result.rendered).not.toContain('tok/s')
        expect(JSON.stringify(canonical)).toBe(before)
    })
})
