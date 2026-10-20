import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import {
    readAutoBridgeTransientModelErrorsEnabled,
    writeAutoBridgeTransientModelErrorsEnabled
} from '../config/autoBridgeTransientModelErrors'
import { SyncEngine } from './syncEngine'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function waitUntil(
    predicate: () => boolean,
    label: string,
    timeoutMs = 2_000
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`timed out waiting for ${label}`)
}

describe('cursor auto-bridge reconcile on session-ready', () => {
    async function setup(opts?: { namespace?: string; flavor?: string }) {
        const dataDir = await mkdtemp(join(tmpdir(), 'hapi-auto-bridge-reconcile-'))
        directories.push(dataDir)

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        engine.setSettingsDataDirForTests(dataDir)

        const session = engine.getOrCreateSession(
            'session-cursor-bootstrapping',
            {
                path: '/tmp/project',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: opts?.flavor ?? 'cursor'
            },
            null,
            opts?.namespace ?? 'default'
        )

        const configCalls: Array<{ sessionId: string; config: Record<string, unknown> }> = []
        ;(engine as unknown as {
            rpcGateway: {
                requestSessionConfig: (
                    sessionId: string,
                    config: Record<string, unknown>
                ) => Promise<unknown>
            }
        }).rpcGateway.requestSessionConfig = async (sessionId, config) => {
            configCalls.push({ sessionId, config })
            return { applied: config }
        }

        return { engine, session, dataDir, configCalls }
    }

    it('pushes enable after session-ready when CLI fetched while inactive', async () => {
        const { engine, session, dataDir, configCalls } = await setup()
        // Simulate Settings toggle while the row is still inactive (create/get
        // already handed the CLI the previous false default).
        expect(session.active).toBe(false)
        await writeAutoBridgeTransientModelErrorsEnabled(dataDir, true)

        engine.handleSessionReady({ sid: session.id, time: Date.now() })
        await waitUntil(() => configCalls.length >= 1, 'session-ready enable fanout')

        expect(configCalls).toEqual([
            {
                sessionId: session.id,
                config: { autoBridgeTransientModelErrors: true }
            }
        ])
    })

    it('pushes disable after session-ready so a stale CLI cannot keep auto-bridging', async () => {
        const { engine, session, dataDir, configCalls } = await setup()
        await writeAutoBridgeTransientModelErrorsEnabled(dataDir, true)
        await writeAutoBridgeTransientModelErrorsEnabled(dataDir, false)

        engine.handleSessionReady({ sid: session.id, time: Date.now() })
        await waitUntil(() => configCalls.length >= 1, 'session-ready disable fanout')

        expect(configCalls).toEqual([
            {
                sessionId: session.id,
                config: { autoBridgeTransientModelErrors: false }
            }
        ])
    })

    it('skips tenant namespaces and non-cursor flavors', async () => {
        const tenant = await setup({ namespace: 'tenant-a' })
        await writeAutoBridgeTransientModelErrorsEnabled(tenant.dataDir, true)
        tenant.engine.handleSessionReady({ sid: tenant.session.id, time: Date.now() })
        // Fire-and-forget skip path: wait long enough for a mistaken RPC, then assert none.
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(tenant.configCalls).toEqual([])

        const claude = await setup({ flavor: 'claude' })
        await writeAutoBridgeTransientModelErrorsEnabled(claude.dataDir, true)
        claude.engine.handleSessionReady({ sid: claude.session.id, time: Date.now() })
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(claude.configCalls).toEqual([])
    })

    it('reconciles on first inactive → active transition after a toggle while inactive', async () => {
        const { engine, session, dataDir, configCalls } = await setup()
        expect(session.active).toBe(false)
        await writeAutoBridgeTransientModelErrorsEnabled(dataDir, true)

        engine.handleSessionAlive({ sid: session.id, time: Date.now() })
        await waitUntil(() => configCalls.length >= 1, 'first-active enable fanout')

        expect(configCalls).toEqual([
            {
                sessionId: session.id,
                config: { autoBridgeTransientModelErrors: true }
            }
        ])
    })

    it('serializes settings fanout with an in-flight session-ready reconcile', async () => {
        const { engine, session, dataDir, configCalls } = await setup()
        await writeAutoBridgeTransientModelErrorsEnabled(dataDir, false)

        const firstRpc = { release: null as (() => void) | null }
        ;(engine as unknown as {
            rpcGateway: {
                requestSessionConfig: (
                    sessionId: string,
                    config: Record<string, unknown>
                ) => Promise<unknown>
            }
        }).rpcGateway.requestSessionConfig = async (sessionId, config) => {
            configCalls.push({ sessionId, config })
            if (configCalls.length === 1) {
                await new Promise<void>((resolve) => {
                    firstRpc.release = resolve
                })
            }
            return { applied: config }
        }

        const reconcilePromise = engine.reconcileCursorAutoBridgeSetting(session.id)
        await waitUntil(() => typeof firstRpc.release === 'function', 'first RPC hold')

        // Become active while the first reconcile still holds the lock, then
        // toggle + fanout so the serialized tail sees the new value.
        engine.handleSessionAlive({ sid: session.id, time: Date.now() })
        await writeAutoBridgeTransientModelErrorsEnabled(dataDir, true)
        const fanoutPromise = engine.fanoutAutoBridgeTransientModelErrors(true)

        firstRpc.release?.()
        await Promise.all([reconcilePromise, fanoutPromise])
        await waitUntil(
            () => configCalls.at(-1)?.config?.autoBridgeTransientModelErrors === true,
            'serialized fanout true'
        )

        expect(configCalls.some((call) => call.config.autoBridgeTransientModelErrors === true)).toBe(true)
        expect(configCalls.at(-1)?.config).toEqual({ autoBridgeTransientModelErrors: true })
    })

    it('heartbeats repair a CLI left enabled after partial fanout + failed rollback', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'hapi-auto-bridge-reconcile-'))
        directories.push(dataDir)
        await writeAutoBridgeTransientModelErrorsEnabled(dataDir, false)

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        engine.setSettingsDataDirForTests(dataDir)

        const sessionA = engine.getOrCreateSession(
            'session-cursor-a',
            { path: '/tmp/a', host: 'localhost', machineId: 'm1', flavor: 'cursor' },
            null,
            'default'
        )
        const sessionB = engine.getOrCreateSession(
            'session-cursor-b',
            { path: '/tmp/b', host: 'localhost', machineId: 'm1', flavor: 'cursor' },
            null,
            'default'
        )

        const configCalls: Array<{ sessionId: string; config: Record<string, unknown> }> = []
        // Fail B on enable (partial forward) and A on the first post-forward disable
        // (failed rollback). Later heartbeats must repair A to persisted false.
        let sawForwardEnableForA = false
        let applyFinished = false
        ;(engine as unknown as {
            rpcGateway: {
                requestSessionConfig: (
                    sessionId: string,
                    config: Record<string, unknown>
                ) => Promise<unknown>
            }
        }).rpcGateway.requestSessionConfig = async (sessionId, config) => {
            configCalls.push({ sessionId, config })
            const enabled = config.autoBridgeTransientModelErrors === true
            if (enabled && sessionId === sessionA.id) {
                sawForwardEnableForA = true
            }
            if (!applyFinished && enabled && sessionId === sessionB.id) {
                throw new Error('forward fanout B failed')
            }
            if (
                !applyFinished
                && sawForwardEnableForA
                && !enabled
                && sessionId === sessionA.id
            ) {
                throw new Error('rollback fanout A failed')
            }
            return { applied: config }
        }

        engine.handleSessionAlive({ sid: sessionA.id, time: Date.now() })
        engine.handleSessionAlive({ sid: sessionB.id, time: Date.now() })
        await waitUntil(
            () => configCalls.filter((call) => call.sessionId === sessionA.id).length >= 1
                && configCalls.filter((call) => call.sessionId === sessionB.id).length >= 1,
            'first-active reconciles'
        )

        await expect(
            engine.applyAutoBridgeTransientModelErrorsSetting(dataDir, true)
        ).rejects.toThrow('Failed to update every active Cursor session')
        applyFinished = true
        expect(await readAutoBridgeTransientModelErrorsEnabled(dataDir)).toBe(false)
        expect(configCalls.some((call) => (
            call.sessionId === sessionA.id
            && call.config.autoBridgeTransientModelErrors === true
        ))).toBe(true)

        const beforeRepair = configCalls.length
        // Already active — heartbeat must still retry pending reconcile.
        engine.handleSessionAlive({ sid: sessionA.id, time: Date.now() + 1 })
        await waitUntil(
            () => configCalls.slice(beforeRepair).some((call) => (
                call.sessionId === sessionA.id
                && call.config.autoBridgeTransientModelErrors === false
            )),
            'heartbeat repair to false'
        )
    })

    it('serializes concurrent apply so a failed PUT cannot clobber a later success', async () => {
        const { engine, session, dataDir, configCalls } = await setup()
        engine.handleSessionAlive({ sid: session.id, time: Date.now() })
        await writeAutoBridgeTransientModelErrorsEnabled(dataDir, false)

        const failHold = { release: null as (() => void) | null }
        let failArmed = true
        ;(engine as unknown as {
            rpcGateway: {
                requestSessionConfig: (
                    sessionId: string,
                    config: Record<string, unknown>
                ) => Promise<unknown>
            }
        }).rpcGateway.requestSessionConfig = async (sessionId, config) => {
            configCalls.push({ sessionId, config })
            if (failArmed && config.autoBridgeTransientModelErrors === true) {
                failArmed = false
                await new Promise<void>((resolve) => {
                    failHold.release = resolve
                })
                throw new Error('simulated fanout failure')
            }
            return { applied: config }
        }

        const failing = engine.applyAutoBridgeTransientModelErrorsSetting(dataDir, true)
        await waitUntil(() => typeof failHold.release === 'function', 'failing apply hold')

        const succeeding = engine.applyAutoBridgeTransientModelErrorsSetting(dataDir, false)
        failHold.release?.()

        await expect(failing).rejects.toThrow('Failed to update every active Cursor session')
        await succeeding

        expect(await readAutoBridgeTransientModelErrorsEnabled(dataDir)).toBe(false)
        expect(configCalls.at(-1)?.config).toEqual({ autoBridgeTransientModelErrors: false })
    })

    it('reconciles an already-active stored Cursor row on first heartbeat after hub restart', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'hapi-auto-bridge-reconcile-'))
        directories.push(dataDir)
        await writeAutoBridgeTransientModelErrorsEnabled(dataDir, false)

        const store = new Store(':memory:')
        const boot = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const session = boot.getOrCreateSession(
            'session-cursor-restart',
            { path: '/tmp/restart', host: 'localhost', machineId: 'm1', flavor: 'cursor' },
            null,
            'default'
        )
        boot.handleSessionAlive({ sid: session.id, time: Date.now() })
        store.sessions.setSessionActive(session.id, true, Date.now(), 'default')
        boot.stop()

        const restarted = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        restarted.setSettingsDataDirForTests(dataDir)
        const configCalls: Array<{ sessionId: string; config: Record<string, unknown> }> = []
        ;(restarted as unknown as {
            rpcGateway: {
                requestSessionConfig: (
                    sessionId: string,
                    config: Record<string, unknown>
                ) => Promise<unknown>
            }
        }).rpcGateway.requestSessionConfig = async (sessionId, config) => {
            configCalls.push({ sessionId, config })
            return { applied: config }
        }

        expect(restarted.getSession(session.id)?.active).toBe(true)
        restarted.handleSessionAlive({ sid: session.id, time: Date.now() + 1 })
        await waitUntil(
            () => configCalls.some((call) => (
                call.sessionId === session.id
                && call.config.autoBridgeTransientModelErrors === false
            )),
            'post-restart heartbeat reconcile'
        )
        restarted.stop()
    })
})
