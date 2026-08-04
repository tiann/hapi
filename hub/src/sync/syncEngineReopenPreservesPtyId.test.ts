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
            ],
            expireInactive: () => {}
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



    it('keeps the archive snapshot persisted across a PTY reopen so a hub restart can still recover it', async () => {
        // The snapshot used for rollback lives only in memory, so clearing the
        // archive metadata before the resume is durably recorded leaves an
        // inactive, non-archived ghost row if the hub restarts in between. The
        // CLI's sessionFactory re-stamps lifecycleState='running' on boot (and
        // drops archivedBy/archiveReason, which it never preserves), so keeping
        // the snapshot until then is safe — this is the same reason Pi defers it.
        const sessionId = insertSession(
            'pty-session-archive-durable',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toEqual({ type: 'success', sessionId, resumed: true })
        const metadata = store.sessions.getSession(sessionId)?.metadata as Record<string, unknown> | undefined
        expect(metadata?.lifecycleState).toBe('archived')
        expect(metadata?.archivedBy).toBe('hub')
        expect(metadata?.archiveReason).toBe('inactivity')
    })

    it('stops a same-id PTY child when the active-state barrier times out', async () => {
        const sessionId = insertSession(
            'pty-session-active-timeout',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        ;(engine as any).rpcGateway.spawnSession = async () => ({ type: 'success', sessionId })
        ;(engine as any).waitForSessionActive = async () => false
        let stoppedSessionId: string | undefined
        ;(engine as any).rpcGateway.stopRunnerSession = async (_machineId: string, sid: string) => {
            stoppedSessionId = sid
            return 'stopped'
        }

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(stoppedSessionId).toBe(sessionId)
        expect((engine.getSessionByNamespace(sessionId, NAMESPACE)?.metadata as any)?.ptyResumeAttempt).toBeUndefined()
    })

    it('stops a same-id PTY child when readiness times out', async () => {
        const sessionId = insertSession(
            'pty-session-ready-timeout',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        ;(engine as any).rpcGateway.spawnSession = async () => {
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }
        ;(engine as any).waitForSessionReady = async () => 'timeout'
        let stoppedSessionId: string | undefined
        ;(engine as any).rpcGateway.stopRunnerSession = async (_machineId: string, sid: string) => {
            stoppedSessionId = sid
            engine.handleSessionEnd({ sid, time: Date.now(), reason: 'error' })
            return 'stopped'
        }

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(stoppedSessionId).toBe(sessionId)
        expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)
    })

    it('persists a quarantine and rejects an immediate retry when the timed-out child stays alive', async () => {
        const sessionId = insertSession(
            'pty-session-still-alive',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }
        ;(engine as any).waitForSessionReady = async () => 'timeout'
        ;(engine as any).rpcGateway.stopRunnerSession = async () => 'still_alive'

        const first = await engine.reopenSession(sessionId, NAMESPACE)
        const second = await engine.reopenSession(sessionId, NAMESPACE)

        expect(first).toMatchObject({ type: 'error', code: 'resume_failed', rollbackSafe: false })
        expect(second).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(spawnCalls).toBe(1)
        expect((engine.getSessionByNamespace(sessionId, NAMESPACE)?.metadata as any)?.ptyResumeAttempt)
            .toMatchObject({ state: 'quarantined', machineId: 'machine-x' })
    })

    it('keeps a persisted PTY quarantine fail-closed across hub restart when the child is still alive', async () => {
        const sessionId = insertSession(
            'pty-session-restart-still-alive',
            baseMetadata({
                lifecycleState: 'running',
                ptyResumeAttempt: { state: 'quarantined', machineId: 'machine-x', startedAt: 1 },
            }),
            { startingMode: 'pty' }
        ).id
        engine.handleSessionAlive({ sid: sessionId, time: Date.now() })

        const restarted = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        ;(restarted as any).machineCache = {
            getOnlineMachinesByNamespace: () => [{ id: 'machine-x', metadata: { host: 'localhost' } }],
            expireInactive: () => {}
        }
        ;(restarted as any).rpcGateway.stopRunnerSession = async () => 'still_alive'

        const result = await restarted.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect((restarted.getSessionByNamespace(sessionId, NAMESPACE)?.metadata as any)?.ptyResumeAttempt)
            .toBeDefined()
        restarted.stop()
    })

    it('reconciles a persisted PTY quarantine after restart when the old child is already gone', async () => {
        const sessionId = insertSession(
            'pty-session-restart-gone',
            baseMetadata({
                lifecycleState: 'running',
                ptyResumeAttempt: { state: 'quarantined', machineId: 'machine-x', startedAt: 1 },
            }),
            { startingMode: 'pty' }
        ).id
        engine.handleSessionAlive({ sid: sessionId, time: Date.now() })

        const restarted = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        ;(restarted as any).machineCache = {
            getOnlineMachinesByNamespace: () => [{ id: 'machine-x', metadata: { host: 'localhost' } }],
            expireInactive: () => {}
        }
        ;(restarted as any).rpcGateway.stopRunnerSession = async () => 'already_gone'
        ;(restarted as any).rpcGateway.spawnSession = async () => {
            restarted.handleSessionAlive({ sid: sessionId, time: Date.now() })
            restarted.handleSessionReady({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }

        const result = await restarted.reopenSession(sessionId, NAMESPACE)

        expect(result).toEqual({ type: 'success', sessionId, resumed: true })
        expect((restarted.getSessionByNamespace(sessionId, NAMESPACE)?.metadata as any)?.ptyResumeAttempt)
            .toBeUndefined()
        restarted.stop()
    })



    it('does not spawn when the durable pre-spawn PTY attempt cannot be written', async () => {
        const sessionId = insertSession(
            'pty-session-attempt-write-fails',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            return { type: 'success', sessionId }
        }
        const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
        ;(store.sessions as any).updateSessionMetadata = (...args: any[]) => {
            if (args[1]?.ptyResumeAttempt?.state === 'resuming') return { result: 'not-found' }
            return (originalUpdate as any)(...args)
        }

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(spawnCalls).toBe(0)
    })

    it('does not spawn after pre-spawn marker CAS retries are exhausted', async () => {
        const sessionId = insertSession(
            'pty-session-attempt-cas-exhausted',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            return { type: 'success', sessionId }
        }
        const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
        ;(store.sessions as any).updateSessionMetadata = (...args: any[]) => {
            if (args[1]?.ptyResumeAttempt?.state === 'resuming') return { result: 'version-mismatch' }
            return (originalUpdate as any)(...args)
        }

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(spawnCalls).toBe(0)
    })

    it('keeps the durable resuming marker when quarantine transition fails', async () => {
        const sessionId = insertSession(
            'pty-session-transition-fails',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        ;(engine as any).rpcGateway.spawnSession = async () => {
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }
        ;(engine as any).waitForSessionReady = async () => 'timeout'
        ;(engine as any).rpcGateway.stopRunnerSession = async () => 'still_alive'
        const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
        ;(store.sessions as any).updateSessionMetadata = (...args: any[]) => {
            if (args[1]?.ptyResumeAttempt?.state === 'quarantined') return { result: 'not-found' }
            return (originalUpdate as any)(...args)
        }

        const first = await engine.reopenSession(sessionId, NAMESPACE)

        expect(first).toMatchObject({ type: 'error', code: 'resume_failed', rollbackSafe: false })
        expect((engine.getSessionByNamespace(sessionId, NAMESPACE)?.metadata as any)?.ptyResumeAttempt)
            .toMatchObject({ state: 'resuming' })

        const restarted = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        ;(restarted as any).rpcGateway.stopRunnerSession = async () => 'still_alive'
        let spawnCalls = 0
        ;(restarted as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            return { type: 'success', sessionId }
        }
        const retry = await restarted.reopenSession(sessionId, NAMESPACE)
        expect(retry).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(spawnCalls).toBe(0)
        restarted.stop()
    })

    it('does not spawn when clearing a reconciled durable PTY marker fails', async () => {
        const sessionId = insertSession(
            'pty-session-clear-fails',
            baseMetadata({
                lifecycleState: 'running',
                ptyResumeAttempt: { state: 'resuming', machineId: 'machine-x', startedAt: 1 },
            }),
            { startingMode: 'pty' }
        ).id
        engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
        ;(engine as any).rpcGateway.stopRunnerSession = async () => 'already_gone'
        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            return { type: 'success', sessionId }
        }
        const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
        ;(store.sessions as any).updateSessionMetadata = (...args: any[]) => {
            if (args[1]?.ptyResumeAttempt === undefined) return { result: 'not-found' }
            return (originalUpdate as any)(...args)
        }

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(spawnCalls).toBe(0)
    })

    it('does not spawn after marker-clear CAS retries are exhausted', async () => {
        const sessionId = insertSession(
            'pty-session-clear-cas-exhausted',
            baseMetadata({
                lifecycleState: 'running',
                ptyResumeAttempt: { state: 'resuming', machineId: 'machine-x', startedAt: 1 },
            }),
            { startingMode: 'pty' }
        ).id
        engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
        ;(engine as any).rpcGateway.stopRunnerSession = async () => 'already_gone'
        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            return { type: 'success', sessionId }
        }
        const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
        ;(store.sessions as any).updateSessionMetadata = (...args: any[]) => {
            if (args[1]?.ptyResumeAttempt === undefined) return { result: 'version-mismatch' }
            return (originalUpdate as any)(...args)
        }

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(spawnCalls).toBe(0)
    })

    it('does not reconcile the durable marker owned by a concurrent direct resume', async () => {
        const sessionId = insertSession(
            'pty-session-resume-then-reopen',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        let releaseSpawn!: () => void
        const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve })
        let spawnCalls = 0
        let stopCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            await spawnGate
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            engine.handleSessionReady({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }
        ;(engine as any).rpcGateway.stopRunnerSession = async () => {
            stopCalls += 1
            return 'still_alive'
        }

        const resume = engine.resumeSession(sessionId, NAMESPACE)
        for (let i = 0; i < 20 && spawnCalls === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
        const reopenResult = await engine.reopenSession(sessionId, NAMESPACE)
        releaseSpawn()
        const resumeResult = await resume

        expect(reopenResult).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(resumeResult).toMatchObject({ type: 'success', sessionId })
        expect(spawnCalls).toBe(1)
        expect(stopCalls).toBe(0)
    })

    it('serializes concurrent PTY reopen requests without reconciling the owner marker', async () => {
        const sessionId = insertSession(
            'pty-session-reopen-twice',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        let releaseSpawn!: () => void
        const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve })
        let spawnCalls = 0
        let stopCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            await spawnGate
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            engine.handleSessionReady({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }
        ;(engine as any).rpcGateway.stopRunnerSession = async () => {
            stopCalls += 1
            return 'still_alive'
        }

        const first = engine.reopenSession(sessionId, NAMESPACE)
        for (let i = 0; i < 20 && spawnCalls === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
        const secondResult = await engine.reopenSession(sessionId, NAMESPACE)
        releaseSpawn()
        const firstResult = await first

        expect(secondResult).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(firstResult).toMatchObject({ type: 'success', sessionId })
        expect(spawnCalls).toBe(1)
        expect(stopCalls).toBe(0)
    })

    it('serializes concurrent PTY reopen and resume requests before spawning', async () => {
        const sessionId = insertSession(
            'pty-session-concurrent',
            baseMetadata({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'inactivity' }),
            { startingMode: 'pty' }
        ).id
        let releaseSpawn!: () => void
        const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve })
        let spawnCalls = 0
        ;(engine as any).rpcGateway.spawnSession = async () => {
            spawnCalls += 1
            await spawnGate
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            engine.handleSessionReady({ sid: sessionId, time: Date.now() })
            return { type: 'success', sessionId }
        }

        const reopen = engine.reopenSession(sessionId, NAMESPACE)
        for (let i = 0; i < 20 && spawnCalls === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
        const resume = engine.resumeSession(sessionId, NAMESPACE)
        releaseSpawn()
        const [reopenResult, resumeResult] = await Promise.all([reopen, resume])

        expect(spawnCalls).toBe(1)
        expect([reopenResult.type, resumeResult.type].sort()).toEqual(['error', 'success'])
    })


})
