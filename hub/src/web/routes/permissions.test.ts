import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createPermissionsRoutes } from './permissions'

function createSession(overrides?: Partial<Session>): Session {
    const base: Session = {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'claude'
        },
        metadataVersion: 1,
        agentState: {
            controlledByUser: false,
            requests: {
                'request-1': {
                    tool: 'exit_plan_mode',
                    arguments: { plan: 'Ship it' },
                    createdAt: 1
                }
            },
            completedRequests: {}
        },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        model: null,
        effort: null,
        permissionMode: 'default'
    }

    return {
        ...base,
        ...overrides,
        metadata: overrides?.metadata === undefined ? base.metadata : overrides.metadata,
        agentState: overrides?.agentState === undefined ? base.agentState : overrides.agentState
    }
}

function createApp(session: Session) {
    const approveCalls: unknown[] = []
    const denyCalls: unknown[] = []
    const engine = {
        resolveSessionAccess: () => ({ ok: true, sessionId: session.id, session }),
        approvePermission: async (...args: unknown[]) => {
            approveCalls.push(args)
        },
        denyPermission: async (...args: unknown[]) => {
            denyCalls.push(args)
        }
    } as Partial<SyncEngine>

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createPermissionsRoutes(() => engine as SyncEngine))

    return { app, approveCalls, denyCalls }
}

describe('permissions routes', () => {
    it('forwards implementationMode for exit_plan_mode approvals', async () => {
        const { app, approveCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/permissions/request-1/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ implementationMode: 'clear_context' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(approveCalls).toEqual([
            ['session-1', 'request-1', undefined, undefined, undefined, undefined, 'clear_context']
        ])
    })

    it('rejects plan mode as a post-plan approval mode', async () => {
        const { app, approveCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/permissions/request-1/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'plan' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Plan mode cannot be selected after exit_plan_mode approval'
        })
        expect(approveCalls).toEqual([])
    })

    it('rejects implementationMode for non-exit-plan permission requests', async () => {
        const session = createSession({
            agentState: {
                controlledByUser: false,
                requests: {
                    'request-1': {
                        tool: 'Edit',
                        arguments: { file_path: 'a.ts' },
                        createdAt: 1
                    }
                },
                completedRequests: {}
            }
        })
        const { app, approveCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/permissions/request-1/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ implementationMode: 'keep_context' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Implementation mode is only supported for exit_plan_mode'
        })
        expect(approveCalls).toEqual([])
    })

    it('rejects implementationMode for non-Claude exit_plan_mode requests', async () => {
        const session = createSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex'
            }
        })
        const { app, approveCalls } = createApp(session)

        const response = await app.request('/api/sessions/session-1/permissions/request-1/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ implementationMode: 'clear_context' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Implementation mode is only supported for Claude exit_plan_mode'
        })
        expect(approveCalls).toEqual([])
    })

    it('rejects invalid approve decisions', async () => {
        const { app, approveCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/permissions/request-1/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'abort' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Invalid body' })
        expect(approveCalls).toEqual([])
    })

    it('rejects invalid deny decisions', async () => {
        const { app, denyCalls } = createApp(createSession())

        const response = await app.request('/api/sessions/session-1/permissions/request-1/deny', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'approved' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Invalid body' })
        expect(denyCalls).toEqual([])
    })
})
