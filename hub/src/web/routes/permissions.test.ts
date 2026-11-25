import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { PermissionRequestNotFoundError } from '../../sync/rpcGateway'
import { createPermissionsRoutes } from './permissions'

function createSession(): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
        metadataVersion: 1,
        agentState: {
            controlledByUser: false,
            requests: {
                'request-1': { tool: 'AskUserQuestion', arguments: {}, createdAt: 1 }
            },
            completedRequests: {}
        },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: 'default',
        collaborationMode: 'default'
    } as Session
}

function createApp(opts?: {
    approvePermission?: SyncEngine['approvePermission']
    denyPermission?: SyncEngine['denyPermission']
}) {
    const session = createSession()
    const engine = {
        resolveSessionAccess: () => ({ ok: true, sessionId: session.id, session }),
        approvePermission: opts?.approvePermission ?? (async () => {}),
        denyPermission: opts?.denyPermission ?? (async () => {})
    } as Partial<SyncEngine>

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createPermissionsRoutes(() => engine as SyncEngine))
    return app
}

// tiann/hapi#1735: a stale/canceled permission request must not silently
// accept an answer — the operator needs to see it failed.
describe('permissions routes (tiann/hapi#1735)', () => {
    it('approves a pending request', async () => {
        const app = createApp()
        const res = await app.request('/api/sessions/session-1/permissions/request-1/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ answers: { '0': ['Alpha'] } })
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
    })

    it('returns 409 when the CLI no longer has the request pending on approve', async () => {
        const app = createApp({
            approvePermission: async () => { throw new PermissionRequestNotFoundError('request-1') }
        })
        const res = await app.request('/api/sessions/session-1/permissions/request-1/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ answers: { '0': ['Alpha'] } })
        })
        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ error: 'Permission request is no longer active: request-1' })
    })

    it('returns 409 when the CLI no longer has the request pending on deny', async () => {
        const app = createApp({
            denyPermission: async () => { throw new PermissionRequestNotFoundError('request-1') }
        })
        const res = await app.request('/api/sessions/session-1/permissions/request-1/deny', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        })
        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ error: 'Permission request is no longer active: request-1' })
    })

    it('404s for a request id the session has never heard of, without calling the engine', async () => {
        let called = false
        const app = createApp({ approvePermission: async () => { called = true } })
        const res = await app.request('/api/sessions/session-1/permissions/unknown-request/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        })
        expect(res.status).toBe(404)
        expect(called).toBe(false)
    })

    it('lets an unrelated engine error propagate instead of being swallowed as a 409', async () => {
        const app = createApp({
            approvePermission: async () => { throw new Error('boom') }
        })
        const res = await app.request('/api/sessions/session-1/permissions/request-1/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        })
        // Hono's default error handling turns an unhandled throw into a 500,
        // not a 409 — the route only special-cases PermissionRequestNotFoundError.
        expect(res.status).toBe(500)
    })
})
