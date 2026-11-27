import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { RpcGateway } from './rpcGateway'
import { SyncEngine } from './syncEngine'

/**
 * tiann/hapi#824 — sync-on-open auto-migration tests.
 *
 * The helper `maybeAutoMigrateLegacyCursorSession` is the per-session gate
 * that runs the transplant migrator inside `resumeSession` before the runner
 * spawns. These tests cover the guard-clause matrix (env flag, metadata
 * shape) and the happy-path metadata refresh.
 *
 * Per tiann/hapi#832: two `agent acp` processes coexist on the same host
 * without conflict, and swear01's tiann/hapi#835 refactors the
 * agent-acp-active lock into a cross-process refcount that explicitly
 * supports this. So this helper does NOT pre-check the lock — the
 * migrator's verify probe runs in an isolated HAPI_HOME (see
 * verifyInTempHome) and the post-migration runner goes through the
 * normal refcount-aware lock acquisition path.
 *
 * The migrator itself has its own 53-test unit suite (cursorLegacyMigrator
 * .test.ts) and 3 integration tests against a real `agent acp`. Here we only
 * verify that the SyncEngine triggers it under the right conditions and
 * honours the env override.
 */
describe('SyncEngine.maybeAutoMigrateLegacyCursorSession', () => {
    let store: Store
    let engine: SyncEngine
    let hapiHomeRoot: string
    let originalEnvFlag: string | undefined
    let originalHapiHome: string | undefined

    function makeLegacySession(overrides: Partial<Session['metadata']> = {}): Session {
        return {
            id: 'session-auto-migrate-test',
            machineId: 'machine-x',
            createdAt: 1000,
            updatedAt: 1000,
            active: false,
            model: null,
            metadata: {
                path: '/tmp/proj',
                host: 'localhost',
                flavor: 'cursor',
                cursorSessionId: 'cursor-uuid-123',
                cursorSessionProtocol: 'stream-json',
                ...overrides
            }
        } as unknown as Session
    }

    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        hapiHomeRoot = mkdtempSync(join(tmpdir(), 'auto-migrate-test-'))
        originalEnvFlag = process.env.HAPI_CURSOR_LEGACY_AUTO_MIGRATE
        originalHapiHome = process.env.HAPI_HOME
        process.env.HAPI_HOME = hapiHomeRoot
        delete process.env.HAPI_CURSOR_LEGACY_AUTO_MIGRATE
    })

    afterEach(() => {
        engine.stop()
        store.close()
        if (originalEnvFlag === undefined) {
            delete process.env.HAPI_CURSOR_LEGACY_AUTO_MIGRATE
        } else {
            process.env.HAPI_CURSOR_LEGACY_AUTO_MIGRATE = originalEnvFlag
        }
        if (originalHapiHome === undefined) {
            delete process.env.HAPI_HOME
        } else {
            process.env.HAPI_HOME = originalHapiHome
        }
        try { rmSync(hapiHomeRoot, { recursive: true, force: true }) } catch {}
    })

    async function callHelper(session: Session): Promise<Session> {
        return await (engine as unknown as {
            maybeAutoMigrateLegacyCursorSession(s: Session, ns: string): Promise<Session>
        }).maybeAutoMigrateLegacyCursorSession(session, 'default')
    }

    function stubMigrator(outcome: { ok: boolean; reason?: string; message?: string }): { calls: Array<{ sessionId: string }> } {
        const calls: Array<{ sessionId: string }> = []
        ;(engine as unknown as { buildMigratorForRequest: (req: unknown) => unknown }).buildMigratorForRequest = () => ({
            migrateOne: async (s: Session) => {
                calls.push({ sessionId: s.id })
                if (outcome.ok) {
                    return {
                        ok: true,
                        sessionId: s.id,
                        legacyStoreDbPath: '/fake',
                        acpSessionDir: '/fake',
                        keptSource: false,
                        replayNotifications: 0,
                        lastUsedModel: null,
                        durationMs: 1
                    }
                }
                return {
                    ok: false,
                    sessionId: s.id,
                    reason: outcome.reason ?? 'internal_error',
                    message: outcome.message ?? 'stub failure',
                    durationMs: 1
                }
            }
        })
        return { calls }
    }

    it('skips non-cursor sessions without calling the migrator', async () => {
        const session = makeLegacySession({ flavor: 'codex' as never })
        const { calls } = stubMigrator({ ok: true })
        const out = await callHelper(session)
        expect(out).toBe(session)
        expect(calls).toHaveLength(0)
    })

    it('skips already-ACP cursor sessions without calling the migrator', async () => {
        const session = makeLegacySession({ cursorSessionProtocol: 'acp' as never })
        const { calls } = stubMigrator({ ok: true })
        const out = await callHelper(session)
        expect(out).toBe(session)
        expect(calls).toHaveLength(0)
    })

    it('skips cursor sessions with no cursorSessionId', async () => {
        const session = makeLegacySession({ cursorSessionId: undefined })
        const { calls } = stubMigrator({ ok: true })
        const out = await callHelper(session)
        expect(out).toBe(session)
        expect(calls).toHaveLength(0)
    })

    it('respects HAPI_CURSOR_LEGACY_AUTO_MIGRATE=0', async () => {
        process.env.HAPI_CURSOR_LEGACY_AUTO_MIGRATE = '0'
        const session = makeLegacySession()
        const { calls } = stubMigrator({ ok: true })
        const out = await callHelper(session)
        expect(out).toBe(session)
        expect(calls).toHaveLength(0)
    })

    it('respects HAPI_CURSOR_LEGACY_AUTO_MIGRATE=false', async () => {
        process.env.HAPI_CURSOR_LEGACY_AUTO_MIGRATE = 'false'
        const session = makeLegacySession()
        const { calls } = stubMigrator({ ok: true })
        const out = await callHelper(session)
        expect(out).toBe(session)
        expect(calls).toHaveLength(0)
    })

    it('proceeds with migration regardless of the agent-acp-active lock state (refcount-aware after #835)', async () => {
        // Per tiann/hapi#832/#835: multiple `agent acp` processes coexist on
        // the same host. The auto-migrate helper does NOT pre-check the
        // lock — the migrator's verify probe uses HAPI_HOME isolation and
        // the post-migration runner uses the refcount-aware lock path.
        const session = makeLegacySession()
        const { calls } = stubMigrator({ ok: true })
        const out = await callHelper(session)
        expect(calls).toHaveLength(1)
        expect(out).toBe(session)
    })

    it('falls back to the original session when migration fails (soft fail)', async () => {
        const session = makeLegacySession()
        const { calls } = stubMigrator({ ok: false, reason: 'target_already_exists', message: 'collision' })
        const out = await callHelper(session)
        expect(calls).toHaveLength(1)
        expect(out).toBe(session)
    })

    it('swallows unexpected migrator errors and returns the original session', async () => {
        const session = makeLegacySession()
        ;(engine as unknown as { buildMigratorForRequest: (req: unknown) => unknown }).buildMigratorForRequest = () => ({
            migrateOne: async () => { throw new Error('boom') }
        })
        const out = await callHelper(session)
        expect(out).toBe(session)
    })

    describe('cold resume on a different host', () => {
        const machineId = 'owner'
        const host = 'remote.example.invalid'
        const workspacePath = '/remote/project'
        const uuid = '018c0000-0000-7000-a000-000000000001'
        const verified = {
            success: true as const, uuid, workspacePath, hostName: host, title: '', durationMs: 1,
            sourceFormat: 'legacy' as const, verifiedLegacyCopy: true as const
        }
        function setup(metadata = {}, machineNamespace = 'default') {
            const session = engine.getOrCreateSession('legacy', {
                flavor: 'cursor', host, path: workspacePath, machineId, homeDir: '/home/owner', cursorSessionId: uuid,
                cursorSessionProtocol: 'stream-json', ...metadata
            }, null, 'default')
            store.messages.addMessage(session.id, { role: 'user', content: 'synthetic history' })
            engine.getOrCreateMachine(machineId, { host, homeDir: '/home/owner', platform: 'linux', happyCliVersion: '0.1.0' }, null, machineNamespace)
            engine.handleMachineAlive({ machineId, time: Date.now() })

            const gateway = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
            const prepare = spyOn(gateway, 'prepareCursorImportForMachine').mockResolvedValue(verified)
            spyOn(gateway, 'getCursorChatStoreStatus').mockResolvedValue({ onDisk: true, store: 'legacy' })
            const protocol = () => engine.getSession(session.id)?.metadata?.cursorSessionProtocol
            let protocolAtSpawn: ReturnType<typeof protocol>
            const spawn = spyOn(gateway, 'spawnSession').mockImplementation(async () => {
                protocolAtSpawn = protocol()
                return { type: 'success', sessionId: session.id }
            })
            spyOn(engine, 'waitForSessionActive').mockResolvedValue(true)
            const resume = () => engine.resumeSession(session.id, 'default')
            return { session, prepare, spawn, resume, protocol, protocolAtSpawn: () => protocolAtSpawn }
        }

        it('resumes the same native thread on its owner with ACP after verifying the copy', async () => {
            const f = setup()
            expect(await f.resume()).toEqual({ type: 'success', sessionId: f.session.id })
            expect(f.prepare.mock.calls).toEqual([[machineId, uuid, workspacePath, { knownMessageCount: 1 }]])
            expect(f.protocolAtSpawn()).toBe('acp')
            const [args] = f.spawn.mock.calls
            expect([args?.[0], args?.[1], args?.[8], args?.[12]]).toEqual([machineId, workspacePath, uuid, f.session.id])
        })

        it.each([
            ['old runner response', { verifiedLegacyCopy: undefined }],
            ['existing ACP destination', { sourceFormat: 'acp' as const }],
            ['different native thread', { uuid: 'other-thread' }],
            ['different workspace', { workspacePath: '/other' }],
            ['different host', { hostName: 'other.example.invalid' }]
        ] as const)('resumes with stream-json for %s', async (_label, change) => {
            const f = setup()
            f.prepare.mockResolvedValue({ ...verified, ...change })
            expect((await f.resume()).type).toBe('success')
            expect(f.prepare).toHaveBeenCalledTimes(1)
            expect(f.protocolAtSpawn()).toBe('stream-json')
            expect(engine.getSession(f.session.id)?.metadata?.cursorMigrationState).toBeUndefined()
        })

        it('can resume on an old runner without the prepare handler', async () => {
            const f = setup()
            f.prepare.mockRejectedValue(new Error('Unknown RPC method'))
            expect((await f.resume()).type).toBe('success')
            expect(f.protocolAtSpawn()).toBe('stream-json')
        })

        it.each([
            ['missing owning id', { machineId: undefined }, 'default'],
            ['wrong owning id', { machineId: 'elsewhere' }, 'default'],
            ['owner in another namespace', {}, 'other'],
            ['recorded home differs from owner', { homeDir: '/home/other' }, 'default'],
            ['recorded host differs from owner', { host: 'elsewhere.example.invalid' }, 'default']
        ] as const)('skips import for %s', async (_label, metadata, machineNamespace) => {
            const f = setup(metadata, machineNamespace)
            await f.resume()
            expect(f.prepare).not.toHaveBeenCalled()
            expect(f.protocol()).toBe('stream-json')
        })

        it('leaves an active remote session running', async () => {
            const f = setup()
            engine.handleSessionAlive({ sid: f.session.id, time: Date.now() })
            expect((await f.resume()).type).toBe('success')
            expect(f.prepare).not.toHaveBeenCalled()
            expect(f.spawn).not.toHaveBeenCalled()
            expect(f.protocol()).toBe('stream-json')
        })

        it('skips the flip and spawn if the session becomes active during prepare', async () => {
            const f = setup()
            f.prepare.mockImplementation(async () => {
                engine.handleSessionAlive({ sid: f.session.id, time: Date.now() })
                return verified
            })
            expect((await f.resume()).type).toBe('success')
            expect(f.prepare).toHaveBeenCalledTimes(1)
            expect(f.spawn).not.toHaveBeenCalled()
            expect(f.protocol()).toBe('stream-json')
        })

        it('honors the opt-out on the remote cold-resume path', async () => {
            process.env.HAPI_CURSOR_LEGACY_AUTO_MIGRATE = 'off'
            const f = setup()
            expect((await f.resume()).type).toBe('success')
            expect(f.prepare).not.toHaveBeenCalled()
            expect(f.protocolAtSpawn()).toBe('stream-json')
        })

        it('discards a verified reply if the workspace moved during prepare', async () => {
            const f = setup()
            f.prepare.mockImplementation(async () => {
                const row = engine.getSession(f.session.id)!
                store.sessions.updateSessionMetadata(row.id, { ...row.metadata!, path: '/moved' }, row.metadataVersion, 'default')
                engine.handleRealtimeEvent({ type: 'session-updated', sessionId: row.id, namespace: 'default' })
                return verified
            })
            await f.resume()
            expect(f.prepare).toHaveBeenCalledTimes(1)
            expect(engine.getSession(f.session.id)?.metadata?.path).toBe('/moved')
            expect(f.protocol()).toBe('stream-json')
        })
    })

    /**
     * UX A++ (Codex #34 round 14): the helper sets
     * `metadata.cursorMigrationState='in_progress'` BEFORE the long-running
     * transplant, surfacing the migration to the web UI via the SSE
     * session-updated event. The flag is cleared on failure (and atomically
     * with the protocol flip on success). These tests pin the metadata
     * transitions so the web banner has a stable contract.
     */
    describe('UX A++ migration-in-progress banner flag', () => {
        // Insert a real cursor legacy session into the store so the helper's
        // metadata writes have something to update.
        function insertLegacy(sessionId: string): Session {
            const cache = (engine as unknown as { sessionCache: import('./sessionCache').SessionCache }).sessionCache
            const persisted = cache.getOrCreateSession(
                sessionId,
                {
                    path: '/tmp/proj',
                    host: 'localhost',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-uuid-real',
                    cursorSessionProtocol: 'stream-json'
                },
                null,
                'default'
            )
            return persisted
        }
        function getStoredMetadata(sessionId: string): Record<string, unknown> | undefined {
            const store = (engine as unknown as { store: Store }).store
            const row = store.sessions.getSession(sessionId)
            if (!row) return undefined
            return row.metadata as unknown as Record<string, unknown>
        }

        it('sets cursorMigrationState=in_progress before the migrator runs and clears it on failure', async () => {
            const session = insertLegacy('session-flag-fail')

            let observedFlagAtMigrate: unknown
            ;(engine as unknown as { buildMigratorForRequest: (req: unknown) => unknown }).buildMigratorForRequest = () => ({
                migrateOne: async (s: Session) => {
                    observedFlagAtMigrate = getStoredMetadata(s.id)?.cursorMigrationState
                    return { ok: false, sessionId: s.id, reason: 'internal_error', message: 'stub fail', durationMs: 1 }
                }
            })

            await callHelper(session)
            expect(observedFlagAtMigrate).toBe('in_progress')
            expect(getStoredMetadata(session.id)?.cursorMigrationState).toBeUndefined()
        })

        it('sets cursorMigrationState=in_progress before the migrator runs and clears it on unexpected exception', async () => {
            const session = insertLegacy('session-flag-exception')

            let observedFlagAtMigrate: unknown
            ;(engine as unknown as { buildMigratorForRequest: (req: unknown) => unknown }).buildMigratorForRequest = () => ({
                migrateOne: async (s: Session) => {
                    observedFlagAtMigrate = getStoredMetadata(s.id)?.cursorMigrationState
                    throw new Error('boom')
                }
            })

            await callHelper(session)
            expect(observedFlagAtMigrate).toBe('in_progress')
            expect(getStoredMetadata(session.id)?.cursorMigrationState).toBeUndefined()
        })

        it('on migrator success the helper does NOT clear the flag (the flip writer is responsible)', async () => {
            // Pins the contract that the helper itself does NOT clear the
            // flag on the ok branch — flipCursorSessionProtocolToAcp does
            // (in the same write that flips the protocol). We stub a
            // migrator that returns ok=true WITHOUT calling the flip path,
            // so the flag should still be set after the helper returns.
            const session = insertLegacy('session-flag-success-no-clear')
            ;(engine as unknown as { buildMigratorForRequest: (req: unknown) => unknown }).buildMigratorForRequest = () => ({
                migrateOne: async (s: Session) => ({
                    ok: true,
                    sessionId: s.id,
                    legacyStoreDbPath: '/fake',
                    acpSessionDir: '/fake',
                    keptSource: false,
                    replayNotifications: 0,
                    lastUsedModel: null,
                    durationMs: 1
                })
            })
            await callHelper(session)
            expect(getStoredMetadata(session.id)?.cursorMigrationState).toBe('in_progress')
        })

        // tiann/hapi#872: on ambiguous_legacy_store / size_mismatch
        // refusals the helper must REPLACE the in-progress flag with
        // 'ambiguous' (not clear it) so the web banner can surface an
        // actionable state instead of silently disappearing.
        it('promotes cursorMigrationState to "ambiguous" on ambiguous_legacy_store refusal (tiann/hapi#872)', async () => {
            const session = insertLegacy('session-ambiguous-banner')
            ;(engine as unknown as { buildMigratorForRequest: (req: unknown) => unknown }).buildMigratorForRequest = () => ({
                migrateOne: async (s: Session) => ({
                    ok: false,
                    sessionId: s.id,
                    reason: 'ambiguous_legacy_store',
                    message: '3 candidates found',
                    durationMs: 1
                })
            })
            await callHelper(session)
            expect(getStoredMetadata(session.id)?.cursorMigrationState).toBe('ambiguous')
        })

        it('promotes cursorMigrationState to "ambiguous" on size_mismatch refusal (tiann/hapi#872)', async () => {
            const session = insertLegacy('session-size-mismatch-banner')
            ;(engine as unknown as { buildMigratorForRequest: (req: unknown) => unknown }).buildMigratorForRequest = () => ({
                migrateOne: async (s: Session) => ({
                    ok: false,
                    sessionId: s.id,
                    reason: 'size_mismatch',
                    message: 'candidate has 19 blobs vs 6000 messages',
                    durationMs: 1
                })
            })
            await callHelper(session)
            expect(getStoredMetadata(session.id)?.cursorMigrationState).toBe('ambiguous')
        })

        it('flipCursorSessionProtocolToAcp clears cursorMigrationState in the same metadata write that flips protocol', () => {
            const session = insertLegacy('session-flip-clears-flag')
            const store = (engine as unknown as { store: Store }).store
            const cache = (engine as unknown as { sessionCache: import('./sessionCache').SessionCache }).sessionCache

            // Manually plant the flag (simulating the helper having run earlier).
            const initial = store.sessions.getSession(session.id)!
            const initialMeta = initial.metadata as unknown as Record<string, unknown>
            store.sessions.updateSessionMetadata(
                session.id,
                { ...initialMeta, cursorMigrationState: 'in_progress' } as unknown as typeof initial.metadata,
                initial.metadataVersion,
                'default',
                { touchUpdatedAt: false }
            )
            cache.refreshSession(session.id)

            expect(getStoredMetadata(session.id)?.cursorMigrationState).toBe('in_progress')

            const result = engine.flipCursorSessionProtocolToAcp(session.id, 'default', null)
            expect(result.result).toBe('success')

            const after = getStoredMetadata(session.id)
            // Both must be true in a SINGLE atomic metadata write.
            expect(after?.cursorSessionProtocol).toBe('acp')
            expect(after?.cursorMigrationState).toBeUndefined()
        })
    })
})
