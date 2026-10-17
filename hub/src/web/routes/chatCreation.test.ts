import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { MACHINE_CAPABILITIES, ChatCreationPreferencesSchema } from '@hapi/protocol'
import { Store } from '../../store'
import { SyncEngine } from '../../sync/syncEngine'
import { RpcRegistry } from '../../socket/rpcRegistry'
import type { WebAppEnv } from '../middleware/auth'
import { createChatCreationRoutes } from './chatCreation'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-create-chat-'))
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() { } } as never)
    cleanups.push(() => { engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }) })
    engine.getOrCreateMachine('machine-1', { host: 'local', platform: 'linux', happyCliVersion: 'test', capabilities: [MACHINE_CAPABILITIES.AgentAvailability] }, null, 'default')
    engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
    engine.getAgentAvailability = async () => ({ agents: [{ agent: 'claude', available: true }, { agent: 'codex', available: true }] })
    engine.listCodexModelsForMachine = async () => ({ success: true, models: [{ id: 'gpt-test', displayName: 'Test', isDefault: true, supportedReasoningEfforts: ['high'], serviceTiers: ['fast'] }] })
    const rpc = (engine as unknown as { rpcGateway: { spawnSession: (...args: unknown[]) => Promise<unknown> } }).rpcGateway
    let spawnArgs: unknown[] = []
    rpc.spawnSession = async (...args) => { spawnArgs = args; return { type: 'success', sessionId: args.at(-1) } }
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', c.req.header('x-test-namespace') ?? 'default'); await next() })
    app.route('/api', createChatCreationRoutes(() => engine, dir))
    const post = (path: string, body: unknown, namespace = 'default') => app.request(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-namespace': namespace }, body: JSON.stringify(body) })
    return { app, post, engine, store, rpc, args: () => spawnArgs }
}

describe('chat creation and shared preferences', () => {
    it('creates a normal independent row and remembers all successful launch options', async () => {
        const { post, app, store, args } = harness()
        const response = await post('/sessions/create', { directory: '/repo', agent: 'codex', model: 'gpt-test', modelReasoningEffort: 'high', serviceTier: 'fast', collaborationMode: 'plan', permissionMode: 'read-only', yolo: false })
        expect(response.status).toBe(200)
        const result = await response.json() as { type: string; sessionId: string }
        expect(result.type).toBe('success')
        const session = store.sessions.getSessionByNamespace(result.sessionId, 'default')!
        expect(session).toBeDefined()
        expect(session.model).toBe('gpt-test')
        expect(session.metadata).toMatchObject({ flavor: 'codex', path: '/repo', machineId: 'machine-1' })
        const preferences = ChatCreationPreferencesSchema.parse(await (await app.request('/api/new-chat-preferences')).json())
        expect(preferences.machines['machine-1'].agents.codex).toMatchObject({ serviceTier: 'fast', collaborationMode: 'plan', permissionMode: 'read-only', yolo: false })
        expect((await post('/sessions/create', { model: null, serviceTier: 'standard' })).status).toBe(200)
        expect(args()[3]).toBeUndefined()
        expect(args()[10]).toBe('read-only')
    })
    it('imports missing browser scopes once without overwriting shared values', async () => {
        const { post } = harness()
        const first = { lastMachineId: 'machine-1', lastAgent: 'codex', machines: { 'machine-1': { directory: '/new', agents: { codex: { model: null, permissionMode: 'read-only' } } } } }
        expect((await post('/new-chat-preferences/import', first)).status).toBe(200)
        const result = ChatCreationPreferencesSchema.parse(await (await post('/new-chat-preferences/import', { ...first, lastAgent: 'claude', machines: { 'machine-1': { directory: '/old', agents: { codex: { model: 'old' }, claude: { model: 'opus' } } } } })).json())
        expect(result.lastAgent).toBe('codex')
        expect(result.machines['machine-1'].directory).toBe('/new')
        expect(result.machines['machine-1'].agents.codex.model).toBeNull()
        expect(result.machines['machine-1'].agents.claude.model).toBe('opus')
    })
    it('isolates namespace preferences and refuses inaccessible machines and parents', async () => {
        const { post, app } = harness()
        await post('/sessions/create', { directory: '/secret' })
        const other = await (await app.request('/api/new-chat-preferences', { headers: { 'x-test-namespace': 'other' } })).json()
        expect(other).toEqual({ machines: {} })
        expect((await post('/sessions/create', { machineId: 'machine-1', directory: '/x' }, 'other')).status).toBe(400)
        const parent = await (await post('/sessions/create', { directory: '/repo' })).json() as { sessionId: string }
        expect((await post(`/sessions/${parent.sessionId}/create-peer`, {}, 'other')).status).toBe(403)
        expect((await post('/sessions/create', { directory: '/x', parentSessionId: parent.sessionId })).status).toBe(400)
    })
    it('binds launch provenance before spawning and retains it across CLI metadata updates', async () => {
        const { post, store, engine } = harness()
        const parent = await (await post('/sessions/create', { directory: '/repo', agent: 'claude' })).json() as { sessionId: string }
        const child = await (await post(`/sessions/${parent.sessionId}/create-peer`, { agent: 'codex' })).json() as { sessionId: string }
        engine.adoptPreallocatedSession(child.sessionId, 'native-child-bootstrap', { path: '/repo', host: 'local', flavor: 'codex' }, null, 'default')
        const row = store.sessions.getSession(child.sessionId)!
        expect(row.metadata).toMatchObject({ flavor: 'codex', launchOrigin: { kind: 'agent', parentSessionId: parent.sessionId } })
        store.sessions.updateSessionMetadata(child.sessionId, { path: '/repo', host: 'local', flavor: 'codex' }, row.metadataVersion, 'default')
        expect(store.sessions.getSession(child.sessionId)!.metadata).toMatchObject({ launchOrigin: { parentSessionId: parent.sessionId } })
    })
    it('rejects invalid combinations and leaves preferences unchanged after a failed spawn', async () => {
        const { post, app, rpc } = harness()
        expect((await post('/sessions/create', { directory: '/x', agent: 'claude', serviceTier: 'fast' })).status).toBe(400)
        expect((await post('/sessions/create', { directory: '/x', agent: 'codex', modelReasoningEffort: 'invalid' })).status).toBe(400)
        expect((await post('/sessions/create', { directory: '/x', agent: 'codex', permissionMode: 'safe-yolo' })).status).toBe(400)
        rpc.spawnSession = async () => ({ type: 'error', errorMessage: 'Unavailable', message: 'Unavailable', childStarted: false })
        expect(((await (await post('/sessions/create', { directory: '/x' })).json()) as { type: string }).type).toBe('error')
        expect(await (await app.request('/api/new-chat-preferences')).json()).toEqual({ machines: {} })
    })
})
