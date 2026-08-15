import { describe, expect, it } from 'bun:test'
import type { Metadata } from '@/api/types'
import { advanceDshHistoryCursor } from './runDsh'

describe('DeepSeek Harness live history cursor', () => {
    it('advances during a turn and never regresses', () => {
        const metadata = {
            path: '/tmp/project',
            host: 'localhost',
            dshHistoryLastEventSeq: 4,
            dshImportState: {
                state: 'complete',
                machineId: 'machine-1',
                dshSessionId: 'native-1',
                sourceUrl: 'http://127.0.0.1:3080',
                startedAt: 100,
                updatedAt: 100,
                lastEventSeq: 4
            }
        } as Metadata

        const advanced = advanceDshHistoryCursor(metadata, 5, 200)
        expect(advanced.dshHistoryLastEventSeq).toBe(5)
        expect(advanced.dshImportState).toMatchObject({ lastEventSeq: 5, updatedAt: 200 })

        const stale = advanceDshHistoryCursor(advanced, 3, 300)
        expect(stale.dshHistoryLastEventSeq).toBe(5)
        expect(stale.dshImportState?.lastEventSeq).toBe(5)
    })
})
