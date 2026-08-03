import { describe, expect, it, beforeEach } from 'bun:test'
import type { Session } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

/**
 * Reopening an archived PTY session must reuse the SAME hub session id.
 *
 * Before the fix `resumeSession` always went through `spawn-in-directory`,
 * which mints a brand-new hub session id; the old row was then deleted by
 * `mergeSessions(oldId, newId, { deleteOldSession: true })`. That made the
 * stable id 404 and surfaced a second (new-id) row in the list.
 *
 * The fix threads the existing hub session id into the spawn RPC for the PTY
 * resume path (via the CLI `existingSessionId` bootstrap), so the runner
 * reuses the row instead of minting a new one — no new id, no merge, no delete.
 *
 * These tests inject a fake `rpcGateway.spawnSession` that faithfully models
 * the runner contract: when an existing hub session id is handed to it the
 * runner reuses that id (same row); otherwise it mints a new hub session id
 * (a fresh row), reproducing the legacy behavior.
 */
describe('SyncEngine reopen/resume PTY session id preservation', () => {
    let store: Store
    let engine: SyncEngine
    let mintedNewId: string | undefined

    const NAMESPACE = 'default'

    function baseMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            path: '/tmp/proj',
            host: 'localhost',
            machineId: 'machine-x',
            flavor: 'agy',
            agySessionId: 'agy-conv-1',
            ...overrides
        }
    }

    /** existingSessionId precedes startingMode in rpcGateway.spawnSession. */
    function readExistingSessionId(args: unknown[]): string | undefined {
        const value = args[12]
        return typeof value === 'string' && value.length > 0 ? value : undefined
    }

    let capturedExistingSessionId: string | undefined
    let staleReadyPresentAtSpawn = false

    function installFakeRunner(): void {
        const cache = (engine as unknown as { sessionCache: import('./sessionCache').SessionCache }).sessionCache
        ;(engine as unknown as { machineCache: unknown }).machineCache = {
            getOnlineMachinesByNamespace: () => [
                { id: 'machine-x', metadata: { host: 'localhost' } }
            ]
        }
        ;(engine as unknown as { waitForSessionActive: unknown }).waitForSessionActive = async () => true
        ;(engine as unknown as { waitForSessionReady: unknown }).waitForSessionReady = async () => 'ready'
        ;(engine as unknown as { rpcGateway: { spawnSession: unknown } }).rpcGateway.spawnSession =
            async (...args: unknown[]) => {
                const existingSessionId = readExistingSessionId(args)
                capturedExistingSessionId = existingSessionId
                staleReadyPresentAtSpawn = existingSessionId
                    ? (engine as unknown as { sessionReadyIds: Set<string> }).sessionReadyIds.has(existingSessionId)
                    : false
                if (existingSessionId) {
                    // Runner honored the existing hub id — reuse the row.
                    return { type: 'success', sessionId: existingSessionId }
                }
                // Legacy: runner mints a brand-new hub session id (new row).
                const created = cache.getOrCreateSession(
                    'runner-minted-new-tag',
                    baseMetadata(),
                    { startingMode: 'pty' },
                    NAMESPACE
                )
                mintedNewId = created.id
                return { type: 'success', sessionId: created.id }
            }
    }

    function insertSession(
        sessionId: string,
        metadata: Record<string, unknown>,
        agentState: Record<string, unknown>
    ): Session {
        const cache = (engine as unknown as { sessionCache: import('./sessionCache').SessionCache }).sessionCache
        return cache.getOrCreateSession(sessionId, metadata, agentState, NAMESPACE)
    }

    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        capturedExistingSessionId = undefined
        mintedNewId = undefined
        staleReadyPresentAtSpawn = false
        installFakeRunner()
    })

    it('clears stale readiness before spawning the same-id PTY replacement', async () => {
        const sessionId = insertSession(
            'pty-session-stale-ready',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        ;(engine as unknown as { sessionReadyIds: Set<string> }).sessionReadyIds.add(sessionId)

        await engine.reopenSession(sessionId, NAMESPACE)

        expect(staleReadyPresentAtSpawn).toBe(false)
    })

    it('reopening an archived PTY session keeps the same hub session id (no new row, old row intact)', async () => {
        const sessionId = insertSession(
            'pty-session-stable',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toEqual({ type: 'success', sessionId, resumed: true })
        expect(capturedExistingSessionId).toBe(sessionId)
        // Old row still exists (not deleted by a merge).
        expect(store.sessions.getSession(sessionId)).not.toBeNull()
        // The runner was never asked to mint a brand-new row.
        expect(mintedNewId).toBeUndefined()
    })


})
