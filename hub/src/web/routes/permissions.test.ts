import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createPermissionsRoutes } from './permissions'

function createApp() {
    const approveCalls: unknown[][] = []
    const denyCalls: unknown[][] = []
    const session = {
        id: 'session-1',
        active: true,
        agentState: { requests: { 'request-1': { tool: 'Shell', arguments: {} } } }
    }
    const engine = {
        resolveSessionAccess: () => ({ ok: true, sessionId: session.id, session }),
        approvePermission: async (...args: unknown[]) => { approveCalls.push(args) },
        denyPermission: async (...args: unknown[]) => { denyCalls.push(args) }
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createPermissionsRoutes(() => engine))
    return { app, approveCalls, denyCalls }
}

describe('permission routes', () => {
    it('rejects approval decisions on the deny endpoint', async () => {
        const { app, denyCalls } = createApp()
        const response = await app.request('/api/sessions/session-1/permissions/request-1/deny', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'approved', optionId: 'allow-once' })
        })

        expect(response.status).toBe(400)
        expect(denyCalls).toEqual([])
    })

    it('rejects denial decisions on the approve endpoint', async () => {
        const { app, approveCalls } = createApp()
        const response = await app.request('/api/sessions/session-1/permissions/request-1/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'denied', optionId: 'reject-once' })
        })

        expect(response.status).toBe(400)
        expect(approveCalls).toEqual([])
    })

    it('forwards decisions consistent with each endpoint', async () => {
        const { app, approveCalls, denyCalls } = createApp()
        const approveResponse = await app.request('/api/sessions/session-1/permissions/request-1/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'approved_for_session', optionId: 'allow-always' })
        })
        const denyResponse = await app.request('/api/sessions/session-1/permissions/request-1/deny', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'abort' })
        })

        expect(approveResponse.status).toBe(200)
        expect(denyResponse.status).toBe(200)
        expect(approveCalls).toEqual([[
            'session-1',
            'request-1',
            undefined,
            undefined,
            'approved_for_session',
            undefined,
            'allow-always'
        ]])
        expect(denyCalls).toEqual([['session-1', 'request-1', 'abort', undefined]])
    })
})
