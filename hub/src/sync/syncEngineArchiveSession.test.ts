import { describe, expect, it, beforeEach } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { RpcTargetMissingError } from './rpcGateway'
import type { SessionCache } from './sessionCache'

/**
 * `archiveSession`'s only kill mechanism is `rpcGateway.killSession`, a
 * session-scoped socket RPC keyed on `${sessionId}:KillSession`. That
 * registration goes stale independently of the actual runner child process
 * — e.g. `SessionCache.mergeSessions` rotates the hub's canonical session id
 * on resume without the CLI re-registering under it, or the session socket
 * is mid-reconnect — so `RpcTargetMissingError` alone does not prove the
 * process is dead.
 *
 * Before this fix, any `RpcTargetMissingError` was treated as "CLI already
 * gone" and the row was unconditionally marked `archived`, silently
 * orphaning a still-running child with no runner-side supervision left
 * pointed at it. The fix confirms with the runner's machine-level
 * `StopSession` RPC (which resolves the child by PID and checks both the
 * requested and confirmed session ids) before trusting that the process is
 * actually gone. It deliberately does NOT pre-check `MachineCache.active`
 * (a 45s heartbeat heuristic) before attempting that RPC — a delayed
 * heartbeat can leave `active` false while the machine's RPC target is
 * still fully registered and reachable — so the RPC's own
 * `RpcTargetMissingError` failure mode is the only signal trusted for
 * "nothing to check."
 */
describe('SyncEngine.archiveSession RpcTargetMissingError fallback', () => {
    let store: Store
    let engine: SyncEngine
    const NAMESPACE = 'default'

    function cache(): SessionCache {
        return (engine as unknown as { sessionCache: SessionCache }).sessionCache
    }

    function insertActiveSession(tag: string, machineId?: string): string {
        const created = cache().getOrCreateSession(
            tag,
            { path: '/tmp/proj', host: 'localhost', flavor: 'claude', ...(machineId ? { machineId } : {}) },
            null,
            NAMESPACE
        )
        cache().markSessionActive(created.id)
        return created.id
    }

    function setKillSessionMissingTarget(): void {
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => { throw new RpcTargetMissingError('KillSession', 'handler-not-registered') }
    }

    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    })

    it('does not archive a session the runner confirms is still alive', async () => {
        const sessionId = insertActiveSession('sess-still-alive', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'still_alive'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('archives the session once the runner confirms the process is gone', async () => {
        const sessionId = insertActiveSession('sess-confirmed-gone', 'machine-x')
        setKillSessionMissingTarget()
        let calledWith: [string, string] | undefined
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (machineId: string, sid: string) => {
                calledWith = [machineId, sid]
                return 'already_gone'
            }

        await engine.archiveSession(sessionId)

        expect(calledWith).toEqual(['machine-x', sessionId])
        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(false)
        expect(session?.metadata?.lifecycleState).toBe('archived')
    })

    it('falls back to archiving when the session has no known machine to verify against', async () => {
        const sessionId = insertActiveSession('sess-no-machine')
        setKillSessionMissingTarget()
        let stopRunnerSessionCalled = false
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { stopRunnerSessionCalled = true; return 'already_gone' }

        await engine.archiveSession(sessionId)

        expect(stopRunnerSessionCalled).toBe(false)
        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(false)
        expect(session?.metadata?.lifecycleState).toBe('archived')
    })

    it('falls back to archiving when the machine has no RPC target at all (RpcTargetMissingError)', async () => {
        // This is the genuinely-unreachable case — mirrors the #916
        // hub-restart-cascade scenario the fallback was originally built
        // for. There is no runner to ask, so "already gone" is the right
        // guess.
        const sessionId = insertActiveSession('sess-machine-unreachable', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { throw new RpcTargetMissingError('StopSession', 'handler-not-registered') }

        await engine.archiveSession(sessionId)

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(false)
        expect(session?.metadata?.lifecycleState).toBe('archived')
    })

    it('does NOT archive when the runner reports the session id as unknown', async () => {
        // cli/src/runner/run.ts's stopSession returns 'unknown' — not
        // 'still_alive' — when no PID matches this id anywhere and there is
        // no verified-exit tombstone. That is NOT confirmation the process
        // is gone: terminal-started sessions are tracked only in-memory
        // (never persisted across a runner restart), so a still-alive
        // terminal session can return 'unknown' right after this exact
        // runner process restarts — indistinguishable, from this RPC alone,
        // from a row this runner generation genuinely never knew about.
        // Treat it conservatively, the same as 'still_alive'.
        const sessionId = insertActiveSession('sess-unknown-to-runner', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'unknown'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('does NOT archive when the StopSession RPC fails ambiguously (not a target-missing error)', async () => {
        // Regression guard: an ack timeout / protocol error from an
        // otherwise-reachable machine must NOT be coerced into "already
        // gone" — that would silently archive a session whose runner
        // simply didn't answer in time, reproducing this fix's own bug one
        // RPC layer down.
        const sessionId = insertActiveSession('sess-machine-ambiguous-failure', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { throw new Error('ack timeout') }

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

})
