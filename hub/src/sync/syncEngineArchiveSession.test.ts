import { describe, expect, it, beforeEach } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { RpcTargetMissingError } from './rpcGateway'
import type { SessionCache } from './sessionCache'

/**
 * #1910 / #1705: `killSession` is a session-socket RPC. A missing target does
 * not prove the runner child is dead. Archive must always ask the runner via
 * `stopRunnerSession` when a machineId is known, and must refuse to archive
 * when the runner reports the process still alive (or unknown).
 */
describe('SyncEngine.archiveSession runner reaping (#1910)', () => {
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

    function setKillSessionOk(): void {
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => undefined
    }

    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    })

    it('does not archive when the runner confirms still_alive after KillSession miss', async () => {
        const sessionId = insertActiveSession('sess-still-alive', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'still_alive'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('always calls stopRunnerSession after a successful KillSession', async () => {
        const sessionId = insertActiveSession('sess-kill-ok', 'machine-x')
        setKillSessionOk()
        let calledWith: [string, string] | undefined
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (machineId: string, sid: string) => {
                calledWith = [machineId, sid]
                return 'already_gone'
            }

        await engine.archiveSession(sessionId)

        expect(calledWith).toEqual(['machine-x', sessionId])
        expect(cache().getSession(sessionId)?.active).toBe(false)
    })

    it('archives once the runner confirms the process is gone', async () => {
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

    it('falls back to archiving when the session has no known machine', async () => {
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

    it('emits Socket.IO update-session when hub-authoring archive without a machine (#1910)', async () => {
        const emitted: Array<{ room: string; event: string; payload: unknown }> = []
        const io = {
            of: (ns: string) => ({
                to: (room: string) => ({
                    emit: (event: string, payload: unknown) => {
                        if (ns === '/cli') {
                            emitted.push({ room, event, payload })
                        }
                    }
                })
            })
        }
        engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const sessionId = insertActiveSession('sess-hub-archive-socket')
        setKillSessionMissingTarget()

        await engine.archiveSession(sessionId)

        expect(emitted).toHaveLength(1)
        expect(emitted[0]?.room).toBe(`session:${sessionId}`)
        expect(emitted[0]?.event).toBe('update')
        const body = (emitted[0]?.payload as { body: { t: string; metadata: { version: number; value: { archivedBy?: string; lifecycleState?: string } } } }).body
        expect(body.t).toBe('update-session')
        expect(body.metadata.value.lifecycleState).toBe('archived')
        expect(body.metadata.value.archivedBy).toBe('hub')
        expect(body.metadata.version).toBeGreaterThan(0)
    })

    it('does NOT archive when the machine RPC target is missing', async () => {
        // Detached children can outlive both KillSession and a missing machine
        // socket; refuse to archive without a confirmed stop (#1910).
        const sessionId = insertActiveSession('sess-machine-unreachable', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { throw new RpcTargetMissingError('StopSession', 'handler-not-registered') }

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('does NOT archive when the runner reports unknown after KillSession miss', async () => {
        const sessionId = insertActiveSession('sess-unknown-to-runner', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'unknown'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('archives when KillSession succeeded even if stopRunnerSession returns unknown', async () => {
        // CLI accepted KillSession and is exiting; runner maps may already be gone.
        const sessionId = insertActiveSession('sess-kill-ok-unknown', 'machine-x')
        setKillSessionOk()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'unknown'

        await engine.archiveSession(sessionId)

        expect(cache().getSession(sessionId)?.active).toBe(false)
    })

    it('does NOT archive when StopSession fails ambiguously', async () => {
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
