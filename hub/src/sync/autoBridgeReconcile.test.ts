import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { writeAutoBridgeTransientModelErrorsEnabled } from '../config/autoBridgeTransientModelErrors'
import { SyncEngine } from './syncEngine'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
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
        await flushAsyncWork()

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
        await flushAsyncWork()

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
        await flushAsyncWork()
        expect(tenant.configCalls).toEqual([])

        const claude = await setup({ flavor: 'claude' })
        await writeAutoBridgeTransientModelErrorsEnabled(claude.dataDir, true)
        claude.engine.handleSessionReady({ sid: claude.session.id, time: Date.now() })
        await flushAsyncWork()
        expect(claude.configCalls).toEqual([])
    })
})
