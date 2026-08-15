import { describe, expect, it } from 'vitest'
import type { Metadata } from '@/api/types'
import {
    advanceDshHistoryCursor,
    bootstrapDshAfterPreflight,
    createDshKillSessionLifecycle,
    DshContiguousEventBuffer,
    findDshPendingPrompt,
    persistContiguousDshEvents,
    persistDshPendingPrompt
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

    it('removes covered HAPI prompt identities in the cursor update', () => {
        const metadata = {
            path: '/tmp/project',
            host: 'localhost',
            dshHistoryLastEventSeq: 4,
            dshPendingPrompts: {
                'rpc-covered': { localIds: ['local-covered'], createdAt: 100 },
                'rpc-pending': { localIds: ['local-pending'], createdAt: 200 }
            }
        } as Metadata

        const advanced = advanceDshHistoryCursor(metadata, 5, 300, ['rpc-covered'])

        expect(advanced.dshHistoryLastEventSeq).toBe(5)
        expect(advanced.dshPendingPrompts).toEqual({
            'rpc-pending': { localIds: ['local-pending'], createdAt: 200 }
        })
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

    it('does not commit the durable cursor when an imported-message write fails', async () => {
        const buffer = new DshContiguousEventBuffer(4)
        buffer.enqueueMany([historyEntry(5), historyEntry(6)])
        const committed: number[] = []

        await expect(persistContiguousDshEvents({
            buffer,
            persistEntry: async (entry) => {
                if (entry.event.seq === 6) throw new Error('import conflict')
            },
            commitCursor: (eventSeq) => {
                committed.push(eventSeq)
            }
        })).rejects.toThrow('import conflict')

        expect(committed).toEqual([])
    })
})

describe('DeepSeek Harness lifecycle boundaries', () => {
    it('finds the durable RPC only for the same queued local-id batch', () => {
        const prompts = new Map([
            ['rpc-1', { localIds: ['local-a', 'local-b'], createdAt: 100 }]
        ])

        expect(findDshPendingPrompt(prompts, ['local-a', 'local-b'])?.rpcId).toBe('rpc-1')
        expect(findDshPendingPrompt(prompts, ['local-a'])).toBeNull()
        expect(findDshPendingPrompt(prompts, ['local-b', 'local-a'])).toBeNull()
    })

    it('waits for durable prompt identity before native submission can continue', async () => {
        let metadata = { path: '/tmp/project', host: 'localhost' } as Metadata
        const order: string[] = []
        const session = {
            updateMetadata: (transform: (current: Metadata) => Metadata) => {
                order.push('update')
                metadata = transform(metadata)
            },
            flushMetadata: async () => {
                order.push('flush')
                return true
            }
        }

        await persistDshPendingPrompt(session, 'rpc-1', ['local-1'], 100)

        expect(order).toEqual(['update', 'flush'])
        expect(metadata.dshPendingPrompts).toEqual({
            'rpc-1': { localIds: ['local-1'], createdAt: 100 }
        })
    })

    it('rejects prompt identity setup when metadata cannot be confirmed', async () => {
        const session = {
            updateMetadata: (_transform: (current: Metadata) => Metadata) => {},
            flushMetadata: async () => false
        }

        await expect(persistDshPendingPrompt(session, 'rpc-1', ['local-1'], 100))
            .rejects.toThrow('Failed to persist DeepSeek Harness prompt identity')
    })

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
