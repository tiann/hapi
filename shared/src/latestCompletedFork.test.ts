import { describe, expect, it } from 'bun:test'
import { ForkConversationRequestSchema } from './apiTypes'
import { MetadataSchema } from './schemas'
import { toSessionSummaryMetadata } from './sessionSummary'

describe('latest completed fork wire contract', () => {
    it('rejects mixed boundary modes while preserving existing requests', () => {
        expect(ForkConversationRequestSchema.parse({ latestCompleted: true })).toEqual({ latestCompleted: true })
        expect(ForkConversationRequestSchema.safeParse({ latestCompleted: true, messageLocalId: 'user' }).success).toBe(false)
        expect(ForkConversationRequestSchema.parse({ messageLocalId: 'user' })).toEqual({ messageLocalId: 'user' })
        expect(ForkConversationRequestSchema.parse({})).toEqual({})
    })
    it('preserves supported and no-completed-history states in list summaries', () => {
        for (const available of [false, true]) {
            const metadata = MetadataSchema.parse({ path: '/work', host: 'test', flavor: 'codex',
                capabilities: { conversationHistory: { forkCurrent: true, forkLatestCompleted: available } } })
            expect(toSessionSummaryMetadata(metadata)?.conversationHistory?.forkLatestCompleted).toBe(available)
        }
    })
})
