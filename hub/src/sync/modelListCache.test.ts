import { describe, expect, it } from 'bun:test'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'
import { RpcTargetMissingError } from './rpcGateway'
import type { RpcGateway } from './rpcGateway'

/**
 * Engine-level wiring tests for the model-list single-flight cache. Model
 * catalogs round-trip to the runner on every picker open even when healthy
 * (observed ~1s floor, 3-13s under load), so the engine serves them through
 * the same SessionEnumerationCache treatment as skill/command enumerations:
 * TTL hits answer without an RPC, failures never get pinned as last-good,
 * and agy catalog updates invalidate proactively. The cache semantics
 * themselves (stale-while-revalidate, cold cap) are covered by
 * sessionEnumerationCache.test.ts; these tests pin the wiring.
 */
describe('SyncEngine model-list cache', () => {
    interface Harness {
        engine: SyncEngine
        rpcCalls: number[]
    }

    function makeEngine(): Harness {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        const rpcCalls: number[] = []
        const gateway = engine as unknown as { rpcGateway: RpcGateway }
        // Counted stubs: every method records a call and answers a distinct
        // success payload so cache hits are distinguishable from re-fetches.
        const counted = <T>(payload: T) => {
            return () => {
                rpcCalls.push(1)
                return Promise.resolve(payload)
            }
        }
        gateway.rpcGateway.listClaudeModelsForMachine = counted({
            success: true,
            availableModels: [{ value: 'opus' }]
        }) as never as RpcGateway['listClaudeModelsForMachine']
        gateway.rpcGateway.listAgyModelsForMachine = counted({
            success: true,
            availableModels: []
        }) as never as RpcGateway['listAgyModelsForMachine']
        gateway.rpcGateway.listDshModelsForSession = counted({
            success: true,
            models: [{ id: 'dsh-1' }]
        }) as never as RpcGateway['listDshModelsForSession']
        gateway.rpcGateway.listPiModelsForSession = counted({
            success: true,
            availableModels: [],
            currentModelId: null
        }) as never as RpcGateway['listPiModelsForSession']
        return { engine, rpcCalls }
    }

    it('serves repeated machine model-list fetches with a single RPC', async () => {
        const { engine, rpcCalls } = makeEngine()

        const first = await engine.listClaudeModelsForMachine('machine-1')
        const second = await engine.listClaudeModelsForMachine('machine-1')

        expect(first.success).toBe(true)
        expect(second).toEqual(first)
        expect(rpcCalls.length).toBe(1)
    })

    it('scopes cache entries per machine', async () => {
        const { engine, rpcCalls } = makeEngine()

        await engine.listClaudeModelsForMachine('machine-1')
        await engine.listClaudeModelsForMachine('machine-2')

        expect(rpcCalls.length).toBe(2)
    })

    it('shares one in-flight fetch across concurrent cold callers', async () => {
        const { engine, rpcCalls } = makeEngine()

        const [a, b] = await Promise.all([
            engine.listClaudeModelsForMachine('machine-1'),
            engine.listClaudeModelsForMachine('machine-1')
        ])

        expect(a).toEqual(b)
        expect(rpcCalls.length).toBe(1)
    })

    it('does not pin error bodies as last-good', async () => {
        const { engine, rpcCalls } = makeEngine()
        const gateway = engine as unknown as { rpcGateway: { listClaudeModelsForMachine: unknown } }
        let failing = true
        gateway.rpcGateway.listClaudeModelsForMachine = (async () => {
            rpcCalls.push(1)
            return failing
                ? { success: false, error: 'catalog unavailable' }
                : { success: true, availableModels: [{ value: 'opus' }] }
        }) as never

        const first = await engine.listClaudeModelsForMachine('machine-1')
        expect(first).toEqual({ success: false, error: 'catalog unavailable' })

        failing = false
        const second = await engine.listClaudeModelsForMachine('machine-1')
        expect(second.success).toBe(true)
        expect(rpcCalls.length).toBe(2)
    })

    it('propagates RPC failures to cold callers without caching them', async () => {
        const { engine, rpcCalls } = makeEngine()
        const gateway = engine as unknown as { rpcGateway: { listClaudeModelsForMachine: unknown } }
        let attempts = 0
        gateway.rpcGateway.listClaudeModelsForMachine = (async () => {
            attempts += 1
            rpcCalls.push(1)
            if (attempts === 1) {
                throw new RpcTargetMissingError('machine-1:listClaudeModels', 'handler-not-registered')
            }
            return { success: true, availableModels: [] }
        }) as never

        await expect(engine.listClaudeModelsForMachine('machine-1')).rejects.toBeInstanceOf(RpcTargetMissingError)

        // The rejection left nothing cached: the next caller refetches.
        const second = await engine.listClaudeModelsForMachine('machine-1')
        expect(second.success).toBe(true)
        expect(rpcCalls.length).toBe(2)
    })

    it('bypasses the cache for an explicit agy refresh and forwards the option', async () => {
        const { engine, rpcCalls } = makeEngine()

        await engine.listAgyModelsForMachine('machine-1')
        const refreshed = await engine.listAgyModelsForMachine('machine-1', { refresh: true })

        expect(refreshed.success).toBe(true)
        expect(rpcCalls.length).toBe(2)
    })

    it('invalidates the agy entry when the runner reports a catalog change', async () => {
        const { engine, rpcCalls } = makeEngine()

        await engine.listAgyModelsForMachine('machine-1')
        expect(rpcCalls.length).toBe(1)

        engine.handleRealtimeEvent({ type: 'machine-agy-models-updated', machineId: 'machine-1' })

        // Inside the TTL window the cached copy would have served; after the
        // invalidation event the next fetch must go back to the runner.
        await engine.listAgyModelsForMachine('machine-1')
        expect(rpcCalls.length).toBe(2)
    })

    it('drops a session model-list entry when the session leaves the active set', async () => {
        const { engine, rpcCalls } = makeEngine()

        await engine.listDshModelsForSession('session-1')
        expect(rpcCalls.length).toBe(1)

        ;(engine as unknown as { releaseSessionEnumerations: (id: string) => void })
            .releaseSessionEnumerations('session-1')

        await engine.listDshModelsForSession('session-1')
        expect(rpcCalls.length).toBe(2)
    })

    it('caches session-scope pi model lists independently of machines', async () => {
        const { engine, rpcCalls } = makeEngine()

        const first = await engine.listPiModelsForSession('session-1')
        const second = await engine.listPiModelsForSession('session-1')

        expect(first.success).toBe(true)
        expect(second).toEqual(first)
        expect(rpcCalls.length).toBe(1)
    })
})
