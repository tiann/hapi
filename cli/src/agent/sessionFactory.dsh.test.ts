import { describe, expect, it } from 'vitest'
import { pickExistingSessionMetadata } from './sessionFactory'

/**
 * H-series: DSH resume identity survives bootstrap (TEST-PLAN.md H1/H3).
 * Every dsh* metadata field must round-trip through
 * pickExistingSessionMetadata — losing any of them on reopen would replay
 * native history (duplicate rows) or lose fork anchors.
 */
describe('pickExistingSessionMetadata preserves the DSH resume identity', () => {
    it('H1: preserves every dsh metadata field', () => {
        const input = {
            name: 'n',
            summary: { text: 's', updatedAt: 1 },
            dshSessionId: 'native-1',
            dshRuntimeVersion: '0.1.0-rc.6',
            dshEventCursor: 123,
            dshChildCursors: { 'child-1': 45, 'child-2': 67 },
            dshSelectedModel: { provider: 'deepseek-official', modelId: 'deepseek-v4' },
            conversationHistoryPoints: { a: true },
            conversationHistoryIndexes: { a: 3 },
            flavor: 'dsh'
        } as never

        const preserved = pickExistingSessionMetadata(input)
        expect(preserved.dshSessionId).toBe('native-1')
        expect(preserved.dshRuntimeVersion).toBe('0.1.0-rc.6')
        expect(preserved.dshEventCursor).toBe(123)
        expect(preserved.dshChildCursors).toEqual({ 'child-1': 45, 'child-2': 67 })
        expect(preserved.dshSelectedModel).toEqual({ provider: 'deepseek-official', modelId: 'deepseek-v4' })
        expect(preserved.conversationHistoryIndexes).toEqual({ a: 3 })
    })

    it('H3: undefined fields are not invented', () => {
        const preserved = pickExistingSessionMetadata({ flavor: 'dsh' } as never)
        expect(preserved.dshSessionId).toBeUndefined()
        expect(preserved.dshEventCursor).toBeUndefined()
        expect(preserved.dshChildCursors).toBeUndefined()
    })
})
