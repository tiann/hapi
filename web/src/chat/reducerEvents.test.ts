import { describe, expect, it } from 'vitest'
import { parseMessageAsEvent, dedupeAgentEvents } from './reducerEvents'
import type { NormalizedMessage, ChatBlock } from './types'

function makeAgentTextMessage(text: string): NormalizedMessage {
    return {
        role: 'agent',
        content: [{ type: 'text', text, uuid: 'u1', parentUUID: null }],
        id: 'msg-1',
        localId: null,
        createdAt: Date.now(),
        isSidechain: false,
    }
}

describe('parseMessageAsEvent — usage limit formats', () => {
    it('parses reached with limitType', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit reached|1774278000|five_hour')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: 'five_hour',
        })
    })

    it('parses reached without limitType (backward compat)', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit reached|1774278000')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: '',
        })
    })

    it('parses warning with five_hour type', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit warning|1774278000|90|five_hour')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-warning',
            utilization: 0.9,
            endsAt: 1774278000,
            limitType: 'five_hour',
        })
    })

    it('parses warning with seven_day type', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit warning|1774850400|85|seven_day')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-warning',
            utilization: 0.85,
            endsAt: 1774850400,
            limitType: 'seven_day',
        })
    })

    it('handles missing limitType', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit warning|1774278000|100|')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-warning',
            utilization: 1,
            endsAt: 1774278000,
            limitType: '',
        })
    })

    it('returns null for non-limit text', () => {
        const msg = makeAgentTextMessage('Hello world')
        expect(parseMessageAsEvent(msg)).toBeNull()
    })

    it('returns null for sidechain messages', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit reached|1774278000')
        msg.isSidechain = true
        expect(parseMessageAsEvent(msg)).toBeNull()
    })
})

describe('exact compaction enrichment', () => {
    it.each([false, true])('keeps one rich card in the original position and preserves surrounding output (%s)', summaryFirst => {
        const boundary: ChatBlock = { kind: 'agent-event', id: 'boundary', createdAt: 1, event: { type: 'compact-summary', summary: '', compactionId: 'thread:turn:item' } }
        const summary: ChatBlock = { kind: 'agent-event', id: 'summary', createdAt: 3, event: { type: 'compact-summary', summary: 'Native body', compactionId: 'thread:turn:item' } }
        const output: ChatBlock = { kind: 'agent-event', id: 'output', createdAt: 2, event: { type: 'message', message: 'Visible output' } }
        const other: ChatBlock = { ...boundary, id: 'other', event: { type: 'compact-summary', summary: '', compactionId: 'other:turn:item' } }
        const result = dedupeAgentEvents([summaryFirst ? summary : boundary, output, summaryFirst ? boundary : summary, other])
        expect(result).toHaveLength(3)
        expect(result[0]).toMatchObject({ id: summaryFirst ? 'summary' : 'boundary', createdAt: summaryFirst ? 3 : 1, event: { summary: 'Native body' } })
        expect(result[1]).toEqual(output)
        expect(result[2]).toEqual(other)
    })
    it.each([false, true])('merges metric-only enrichment in either order, including zero, without losing a summary (%s)', metricsFirst => {
        const body: ChatBlock = { kind: 'agent-event', id: 'body', createdAt: 1, event: { type: 'compact-summary', summary: 'Native body', compactionId: 'exact', tokensBefore: 100 } }
        const metric: ChatBlock = { kind: 'agent-event', id: 'metric', createdAt: 3, event: { type: 'compact-summary', summary: '', compactionId: 'exact', estimatedTokensAfter: 0 } }
        const output: ChatBlock = { kind: 'agent-event', id: 'output', createdAt: 2, event: { type: 'message', message: 'Visible final' } }
        const empty: ChatBlock = { kind: 'agent-event', id: 'empty', createdAt: 4, event: { type: 'compact-summary', summary: '', compactionId: 'exact' } }
        const result = dedupeAgentEvents([metricsFirst ? metric : body, output, metricsFirst ? body : metric, empty])
        expect(result).toEqual([{ ...(metricsFirst ? metric : body), event: { type: 'compact-summary', summary: 'Native body', compactionId: 'exact', tokensBefore: 100, estimatedTokensAfter: 0 } }, output])
    })
    it.each(['tokensBefore', 'tokensAfter', 'estimatedTokensAfter'] as const)('preserves valid %s when an invalid late value arrives', field => {
        const boundary: ChatBlock = { kind: 'agent-event', id: 'boundary', createdAt: 1, event: { type: 'compact-summary', summary: '', compactionId: 'exact', [field]: 0 } }
        const invalid: ChatBlock = { ...boundary, id: 'invalid', event: { type: 'compact-summary', summary: '', compactionId: 'exact', [field]: -1 } }
        expect(dedupeAgentEvents([boundary, invalid])).toEqual([boundary])
    })

})
