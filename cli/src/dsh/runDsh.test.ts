import { describe, expect, it } from 'vitest'
import type { Metadata } from '@/api/types'
import {
    advanceDshHistoryCursor,
    bootstrapDshAfterPreflight,
    createDshKillSessionLifecycle,
    DshContiguousEventBuffer
} from './runDsh'
import type { DshHistoryEntry, DshWebClient } from './dshWebClient'

function historyEntry(seq: number): DshHistoryEntry {
    return { event: { type: 'turn/start', seq, time: 1_000 + seq, data: {} } }
}

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

    it('holds a future mux event until history fills the sequence gap', () => {
        const buffer = new DshContiguousEventBuffer(4)
        buffer.enqueue(historyEntry(6))

        expect(buffer.takeContiguous()).toEqual([])
        expect(buffer.cursor).toBe(4)
        expect(buffer.hasPendingGap).toBe(true)

        buffer.enqueue(historyEntry(5))
        expect(buffer.takeContiguous().map((entry) => entry.event.seq)).toEqual([5, 6])
        expect(buffer.cursor).toBe(6)
        expect(buffer.hasPendingGap).toBe(false)
    })

    it('never advances when native history cannot fill the missing sequence', () => {
        const buffer = new DshContiguousEventBuffer(10)
        buffer.enqueueMany([historyEntry(12), historyEntry(13)])

        expect(buffer.takeContiguous()).toEqual([])
        expect(buffer.cursor).toBe(10)
    })
})

describe('DeepSeek Harness lifecycle boundaries', () => {
    it('finishes DSH preflight before materializing a HAPI session', async () => {
        const order: string[] = []
        const client = {
            describe: async () => {
                order.push('describe')
                throw new Error('DSH unavailable')
            }
        } as unknown as Pick<DshWebClient, 'describe'>

        await expect(bootstrapDshAfterPreflight(client, async () => {
            order.push('bootstrap')
            return 'session'
        })).rejects.toThrow('DSH unavailable')
        expect(order).toEqual(['describe'])
    })

    it('cancels native work before an explicit archive and still cleans up on cancel failure', async () => {
        const order: string[] = []
        const wrapped = createDshKillSessionLifecycle({
            lifecycle: {
                setArchiveReason: () => {},
                cleanupAndExit: async () => {
                    order.push('cleanup')
                }
            },
            client: {
                cancel: async (sessionId: string) => {
                    order.push(`cancel:${sessionId}`)
                    throw new Error('cancel failed')
                }
            },
            getNativeSessionId: () => 'native-1',
            isThinking: () => true
        })

        await wrapped.cleanupAndExit()
        expect(order).toEqual(['cancel:native-1', 'cleanup'])
    })
})
