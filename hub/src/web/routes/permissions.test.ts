import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createPermissionsRoutes } from './permissions'

function createApp() {
    const session = {
        id: 'session-1',
        namespace: 'default',
        active: true,
        metadata: {
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'codex'
        },
        agentState: {
            controlledByUser: false,
            requests: {
                'request-1': {
                    tool: 'Bash',
                    arguments: { command: 'echo hello' },
                    createdAt: 1
                }
            },
            completedRequests: {}
        }
    } as unknown as Session
    const approveCalls: Array<unknown[]> = []
    const denyCalls: Array<unknown[]> = []
    const engine = {
        resolveSessionAccess: () => ({ ok: true as const, sessionId: session.id, session }),
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

async function postDecision(path: 'approve' | 'deny', decision?: string) {
    const harness = createApp()
    const body = decision === undefined ? {} : { decision }
    const response = await harness.app.request(`/api/sessions/session-1/permissions/request-1/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    })
    return { ...harness, response }
}

describe('permission routes', () => {
    for (const decision of ['denied', 'abort'] as const) {
        it(`rejects contradictory ${decision} decisions on the approve endpoint`, async () => {
            const { response, approveCalls, denyCalls } = await postDecision('approve', decision)

            expect(response.status).toBe(400)
            expect(approveCalls).toEqual([])
            expect(denyCalls).toEqual([])
        })
    }

    for (const decision of ['approved', 'approved_for_session'] as const) {
        it(`rejects contradictory ${decision} decisions on the deny endpoint`, async () => {
            const { response, approveCalls, denyCalls } = await postDecision('deny', decision)

            expect(response.status).toBe(400)
            expect(approveCalls).toEqual([])
            expect(denyCalls).toEqual([])
        })
    }

    for (const decision of [undefined, 'approved', 'approved_for_session'] as const) {
        it(`accepts ${decision ?? 'an omitted'} approve decision`, async () => {
            const { response, approveCalls, denyCalls } = await postDecision('approve', decision)

            expect(response.status).toBe(200)
            expect(approveCalls).toHaveLength(1)
            expect(denyCalls).toEqual([])
        })
    }

    for (const decision of [undefined, 'denied', 'abort'] as const) {
        it(`accepts ${decision ?? 'an omitted'} deny decision`, async () => {
            const { response, approveCalls, denyCalls } = await postDecision('deny', decision)

            expect(response.status).toBe(200)
            expect(approveCalls).toEqual([])
            expect(denyCalls).toHaveLength(1)
        })
    }
})
