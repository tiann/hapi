import { beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import { createCursorLocalSessionRoutes } from './cursorLocalSessions'

function authApp(store: Store, engine: SyncEngine) {
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createCursorLocalSessionRoutes({
        store,
        getSyncEngine: () => engine
    }))
    return app
}

describe('cursor local session routes', () => {
    let store: Store

    beforeEach(() => {
        store = new Store(':memory:')
    })

    it('lists Cursor sessions through ListLocalSessions and stamps already-imported', async () => {
        store.sessions.getOrCreateSession('tag', {
            path: '/tmp/proj',
            host: 'host',
            flavor: 'cursor',
            cursorSessionId: 'cur-1',
            cursorSessionProtocol: 'acp',
            machineId: 'm1',
            lifecycleState: 'imported',
            lifecycleStateSince: 1
        }, null, 'default')

        const engine = {
            getOnlineMachinesByNamespace: () => [{
                id: 'm1',
                active: true,
                metadata: {
                    capabilities: [MACHINE_CAPABILITIES.LocalSessionImport],
                    workspaceRoots: ['/tmp']
                }
            }],
            getMachine: () => ({ id: 'm1', metadata: { homeDir: '/home/op' } }),
            listLocalSessionsForMachine: async () => ({
                success: true as const,
                sessions: [{
                    flavor: 'cursor' as const,
                    id: 'cur-1',
                    title: 'Already in',
                    cwd: '/tmp/proj',
                    file: '/home/op/.cursor/acp-sessions/cur-1/store.db',
                    modifiedAt: 10,
                    extra: { sourceFormat: 'acp', sizeBytes: 12 }
                }, {
                    flavor: 'cursor' as const,
                    id: 'cur-2',
                    title: 'Fresh',
                    cwd: '/tmp/proj',
                    file: '/home/op/.cursor/acp-sessions/cur-2/store.db',
                    modifiedAt: 11,
                    extra: { sourceFormat: 'acp', sizeBytes: 20 }
                }]
            }),
            prepareCursorImportForMachine: async () => {
                throw new Error('list path must not prepare')
            },
            getOrCreateSession: () => {
                throw new Error('list path must not create')
            }
        } as unknown as SyncEngine

        const res = await authApp(store, engine).request('/api/cursor/sessions?machineId=m1')
        expect(res.status).toBe(200)
        const body = await res.json() as {
            success: boolean
            sessions: Array<{ id: string; hapiSessionId?: string }>
            machineId: string
        }
        expect(body.success).toBe(true)
        expect(body.machineId).toBe('m1')
        expect(body.sessions.find((s) => s.id === 'cur-1')?.hapiSessionId).toBeTruthy()
        expect(body.sessions.find((s) => s.id === 'cur-2')?.hapiSessionId).toBeUndefined()
    })

    it('imports by preparing then creating an attach-only session', async () => {
        const created: Array<{ metadata: Record<string, unknown> }> = []
        const engine = {
            getOnlineMachinesByNamespace: () => [{
                id: 'm1',
                active: true,
                metadata: {
                    capabilities: [MACHINE_CAPABILITIES.LocalSessionImport],
                    workspaceRoots: ['/tmp'],
                    homeDir: '/home/op'
                }
            }],
            getMachine: () => ({
                id: 'm1',
                metadata: { homeDir: '/home/op', host: 'box' }
            }),
            listLocalSessionsForMachine: async () => ({
                success: true as const,
                sessions: [{
                    flavor: 'cursor' as const,
                    id: 'cur-new',
                    title: 'Fresh chat',
                    cwd: '/tmp/proj',
                    file: '/home/op/.cursor/chats/abc/cur-new/store.db',
                    modifiedAt: 11,
                    extra: { sourceFormat: 'legacy', sizeBytes: 20 }
                }]
            }),
            prepareCursorImportForMachine: async (_machineId: string, uuid: string, workspacePath: string | null) => ({
                success: true as const,
                uuid,
                sourceFormat: 'legacy' as const,
                workspacePath: workspacePath || '/tmp/proj',
                title: 'Fresh chat',
                hostName: 'box',
                durationMs: 12
            }),
            getOrCreateSession: (_tag: string, metadata: Record<string, unknown>) => {
                created.push({ metadata })
                return { id: 'hapi-cur-new' }
            }
        } as unknown as SyncEngine

        const res = await authApp(store, engine).request('/api/cursor/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionIds: ['cur-new'], machineId: 'm1' })
        })
        expect(res.status).toBe(200)
        const body = await res.json() as {
            success: boolean
            results: Array<{ cursorSessionId: string; hapiSessionId?: string; action?: string; appended?: number; error?: unknown }>
        }
        expect(body.success).toBe(true)
        expect(body.results).toEqual([{
            cursorSessionId: 'cur-new',
            hapiSessionId: 'hapi-cur-new',
            action: 'created',
            appended: 0
        }])
        expect(created[0]?.metadata.flavor).toBe('cursor')
        expect(created[0]?.metadata.cursorSessionId).toBe('cur-new')
        expect(created[0]?.metadata.cursorSessionProtocol).toBe('acp')
    })

    it('maps prepare refusal into a per-row error', async () => {
        const engine = {
            getOnlineMachinesByNamespace: () => [{
                id: 'm1',
                active: true,
                metadata: {
                    capabilities: [MACHINE_CAPABILITIES.LocalSessionImport],
                    workspaceRoots: ['/tmp']
                }
            }],
            getMachine: () => ({ id: 'm1', metadata: { homeDir: '/home/op' } }),
            listLocalSessionsForMachine: async () => ({
                success: true as const,
                sessions: [{
                    flavor: 'cursor' as const,
                    id: 'bad',
                    title: 'Bad',
                    cwd: '/tmp/proj',
                    file: '/x/store.db',
                    modifiedAt: 1
                }]
            }),
            prepareCursorImportForMachine: async () => ({
                success: false as const,
                uuid: 'bad',
                reason: 'verify_load_failed',
                message: 'session/load failed',
                durationMs: 3
            }),
            getOrCreateSession: () => {
                throw new Error('must not create after refusal')
            }
        } as unknown as SyncEngine

        const res = await authApp(store, engine).request('/api/cursor/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionIds: ['bad'], machineId: 'm1' })
        })
        const body = await res.json() as {
            success: boolean
            results: Array<{ error?: { code: string; message: string } }>
        }
        expect(body.success).toBe(false)
        expect(body.results[0]?.error).toEqual({
            code: 'verify_load_failed',
            message: 'session/load failed'
        })
    })
})
