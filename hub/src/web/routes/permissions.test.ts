import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { CODEX_ASYNC_QUESTION_REQUEST_PREFIX, CODEX_QUESTION_REISSUED, PERMISSION_REQUEST_NOT_FOUND_MESSAGE } from '@hapi/protocol/rpcMethods'
import type { Server } from 'socket.io'
import type { RpcRegistry } from '../../socket/rpcRegistry'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { PermissionRequestNotFoundError, RpcGateway } from '../../sync/rpcGateway'
import { createPermissionsRoutes } from './permissions'

function createSession(flavor: 'claude' | 'codex' = 'claude'): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { path: '/tmp/project', host: 'localhost', flavor },
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
    session?: Session
    approvePermission?: SyncEngine['approvePermission']
    denyPermission?: SyncEngine['denyPermission']
}) {
    const session = opts?.session ?? createSession()
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

    it('rejects a failed Codex async answer RPC and accepts a subsequent corrected answer', async () => {
        const id = `${CODEX_ASYNC_QUESTION_REQUEST_PREFIX}test`
        const session = createSession('codex')
        session.agentState = { requests: { [id]: { tool: 'request_user_input', arguments: { isBlocking: false } } } }
        let reply = { error: 'An answer is required' } as { error: string } | { ok: true }
        const socket = { timeout: () => ({ emitWithAck: async () => JSON.stringify(reply) }) }
        const io = { of: () => ({ sockets: new Map([['socket-1', socket]]) }) } as unknown as Server
        const registry = { getSocketIdForMethod: () => 'socket-1' } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, registry)
        const app = createApp({ session, approvePermission: gateway.approvePermission.bind(gateway) })
        const answer = (answers: string[]) => app.request(`/api/sessions/session-1/permissions/${encodeURIComponent(id)}/approve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ answers: { q: { answers } } })
        })

        expect((await answer(['None of the above'])).status).toBe(422)
        reply = { ok: true }
        expect((await answer(['None of the above', 'user_note: corrected'])).status).toBe(200)
    })

    it('rejects dismiss while an async answer is in flight even if the answer later fails', async () => {
        const id = `${CODEX_ASYNC_QUESTION_REQUEST_PREFIX}test`
        const session = createSession('codex')
        session.agentState = { requests: { [id]: { tool: 'request_user_input', arguments: { isBlocking: false } } } }
        const started = Promise.withResolvers<void>()
        const inFlight = Promise.withResolvers<string>()
        const socket = { timeout: () => ({ emitWithAck: async (_event: string, request: { params: string }) => {
            if (!JSON.parse(request.params).approved) {
                return JSON.stringify({ error: 'Question already submitted or unavailable' })
            }
            started.resolve()
            return inFlight.promise
        } }) }
        const io = { of: () => ({ sockets: new Map([['socket-1', socket]]) }) } as unknown as Server
        const registry = { getSocketIdForMethod: () => 'socket-1' } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, registry)
        const app = createApp({
            session, approvePermission: gateway.approvePermission.bind(gateway), denyPermission: gateway.denyPermission.bind(gateway)
        })
        const post = (action: 'approve' | 'deny') => app.request(`/api/sessions/session-1/permissions/${encodeURIComponent(id)}/${action}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(action === 'approve' ? { answers: { q: ['Web'] } } : {})
        })

        const answering = post('approve')
        await started.promise
        const dismissal = await post('deny')
        inFlight.resolve(JSON.stringify({ error: 'Native input failed' }))
        expect(dismissal.status).toBe(422)
        expect((await answering).status).toBe(422)
        expect(session.agentState.requests?.[id]).toBeDefined()
    })

    it('forwards the expected issuance and returns a distinguishable conflict for a replacement', async () => {
        const id = `${CODEX_ASYNC_QUESTION_REQUEST_PREFIX}test`
        const session = createSession('codex')
        session.agentState = { requests: { [id]: { tool: 'request_user_input', arguments: {}, instanceId: 'replacement' } } }
        const socket = { timeout: () => ({ emitWithAck: async (_event: string, request: { params: string }) => {
            const { instanceId } = JSON.parse(request.params)
            if (instanceId === 'original') return JSON.stringify({ error: CODEX_QUESTION_REISSUED })
            return JSON.stringify({ ok: true })
        } }) }
        const io = { of: () => ({ sockets: new Map([['socket-1', socket]]) }) } as unknown as Server
        const registry = { getSocketIdForMethod: () => 'socket-1' } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, registry)
        const app = createApp({
            session, approvePermission: gateway.approvePermission.bind(gateway), denyPermission: gateway.denyPermission.bind(gateway)
        })
        for (const action of ['approve', 'deny']) {
            const response = await app.request(`/api/sessions/session-1/permissions/${encodeURIComponent(id)}/${action}`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instanceId: 'original' })
            })
            expect(response.status).toBe(409)
            expect(await response.json()).toEqual({ error: 'Question was reissued', code: CODEX_QUESTION_REISSUED })
        }
    })

    it('returns 404 if the Codex runner already consumed an async question the hub still lists', async () => {
        const id = `${CODEX_ASYNC_QUESTION_REQUEST_PREFIX}test`
        const session = createSession('codex')
        session.agentState = { requests: { [id]: { tool: 'request_user_input', arguments: { isBlocking: false } } } }
        const socket = { timeout: () => ({
            emitWithAck: async () => JSON.stringify({ error: PERMISSION_REQUEST_NOT_FOUND_MESSAGE })
        }) }
        const io = { of: () => ({ sockets: new Map([['socket-1', socket]]) }) } as unknown as Server
        const registry = { getSocketIdForMethod: () => 'socket-1' } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, registry)
        const app = createApp({
            session, approvePermission: gateway.approvePermission.bind(gateway), denyPermission: gateway.denyPermission.bind(gateway)
        })
        for (const action of ['approve', 'deny']) {
            const response = await app.request(`/api/sessions/session-1/permissions/${encodeURIComponent(id)}/${action}`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
            })
            expect(response.status).toBe(404)
        }
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
