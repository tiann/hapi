import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { createConfiguration, resetConfigurationForTests } from '../../configuration'
import { Store } from '../../store'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { SyncEngine } from '../../sync/syncEngine'
import { createCliRoutes } from './cli'

function createEngine(store: Store): SyncEngine {
    const engine = new SyncEngine(
        store,
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    engine.stop()
    return engine
}

function authHeaders() {
    return {
        authorization: 'Bearer test-token'
    }
}

function nullOutActiveAt(store: Store, sessionId: string): void {
    const db = (store as unknown as { db: Database }).db
    db.prepare('UPDATE sessions SET active_at = NULL WHERE id = ?').run(sessionId)
}

let homeDir = ''
let previousHapiHome: string | undefined

beforeAll(async () => {
    previousHapiHome = process.env.HAPI_HOME
    homeDir = mkdtempSync(join(tmpdir(), 'hapi-cli-active-at-test-'))
    process.env.HAPI_HOME = homeDir
    resetConfigurationForTests()
    const config = await createConfiguration()
    config._setCliApiToken('test-token', 'env', false)
})

afterAll(() => {
    if (previousHapiHome === undefined) delete process.env.HAPI_HOME
    else process.env.HAPI_HOME = previousHapiHome
    if (homeDir) {
        resetConfigurationForTests(homeDir)
        rmSync(homeDir, { recursive: true, force: true })
    }
})

describe('CLI GET /sessions/:id with null active_at', () => {
    it('returns numeric activeAt coerced from createdAt', async () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)
        const created = engine.getOrCreateSession(
            'null-active-at-cli',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        nullOutActiveAt(store, created.id)
        expect(store.sessions.getSession(created.id)?.activeAt).toBeNull()

        // Simulate hub restart so cache reloads from the NULL row.
        const reloaded = createEngine(store)
        const app = new Hono()
        app.route('/cli', createCliRoutes(() => reloaded))

        const response = await app.request(`/cli/sessions/${created.id}`, {
            headers: authHeaders()
        })

        expect(response.status).toBe(200)
        const body = await response.json() as {
            session: { activeAt: unknown; createdAt: number; updatedAt: number }
        }
        expect(typeof body.session.activeAt).toBe('number')
        expect(body.session.activeAt).toBe(created.createdAt)
        store.close()
    })
})
