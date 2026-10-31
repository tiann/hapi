import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

const compactionId = 'codex:thread:turn:item:context_compacted'
const boundary = { type: 'context_compacted', id: compactionId }
const summary = { type: 'compact-summary', summary: 'Native checkpoint summary', compactionId }
const answer = { type: 'message', message: 'Normal final answer is preserved.' }
const other = { type: 'context_compacted', id: 'codex:other:turn:item:context_compacted' }
function codex(id: string, seq: number, data: unknown) {
    return wireMessage({ id, seq, createdAt: T0 + (seq - 1) * 100, content: { role: 'agent', content: { type: 'codex', data } } })
}

export const compactionCases: FixtureCase[] = [
    ...([false, true] as const).map((summaryFirst): FixtureCase => ({
        name: summaryFirst ? 'codex-compaction-summary-before-boundary' : 'codex-compaction-summary-enriches-boundary',
        description: 'A readable summary enriches only its exact persisted compaction boundary, across intervening real output and either replay order.',
        messages: [codex('boundary', 1, summaryFirst ? summary : boundary), codex('answer', 2, answer), codex('summary', 3, summaryFirst ? boundary : summary), codex('other', 4, other)]
    })),
    {
        name: 'codex-context-compacted-boundary',
        description: 'Codex completion without native summary/token facts remains a plain status.',
        messages: [codex('msg-codex-boundary', 1, { type: 'context_compacted', thread_id: 'thread-42' })]
    },
    {
        name: 'event-compaction-identity-malformed',
        description: 'Malformed compaction identities cannot collide or throw across clients.',
        messages: [
            codex('object', 1, { type: 'compact-summary', summary: 'Visible', compactionId: { bad: true } }),
            codex('array', 2, { type: 'compact-summary', summary: 'Also visible', compactionId: ['bad'] }),
            wireMessage({ id: 'custom', seq: 3, createdAt: T0 + 200, content: { role: 'event', content: { type: 'custom', compactionId: { bad: true } } } })
        ]
    },
    ...([false, true] as const).flatMap(metricsFirst => ([false, true] as const).map((hasSummary): FixtureCase => {
        const metrics = { type: 'compact-summary', summary: '', compactionId, estimatedTokensAfter: 0 }
        const content = hasSummary ? summary : boundary
        return {
            name: `codex-compaction-${hasSummary ? 'summary' : 'boundary'}-metrics-${metricsFirst ? 'first' : 'last'}`,
            description: 'Exact compaction identity merges token-only enrichment in either order, preserves explicit zero and readable content, and leaves other namespaces/final answers unchanged.',
            messages: [codex('first', 1, metricsFirst ? metrics : content), codex('answer', 2, answer), codex('second', 3, metricsFirst ? content : metrics), codex('replay', 4, boundary), codex('other', 5, other)]
        }
    })),
    {
        name: 'codex-compaction-metric-merge-validity',
        description: 'Partial exact/estimated facts merge independently, missing and invalid later values do not erase valid zero or summary.',
        messages: [
            codex('first', 1, { ...summary, tokensBefore: 100, estimatedTokensAfter: 3 }),
            codex('answer', 2, answer),
            codex('second', 3, { type: 'compact-summary', compactionId, summary: '', tokensAfter: 0 }),
            codex('invalid', 4, { type: 'compact-summary', compactionId, summary: '', tokensBefore: -1, tokensAfter: -1, estimatedTokensAfter: -1 })
        ]
    }
]
