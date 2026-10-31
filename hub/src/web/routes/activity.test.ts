import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { AgentActivityResponse } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createActivityRoutes } from './activity'

function createApp(store: Store, namespace: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createActivityRoutes(store))
    return app
}

describe('GET /api/activity', () => {
    it('returns turns, waits and what identifies each session', async () => {
        const store = new Store(':memory:')
        try {
            store.machines.getOrCreateMachine('machine-1', { host: 'studio.local', platform: 'darwin', happyCliVersion: '1', displayName: 'Studio' }, null, 'default')
            const session = store.sessions.getOrCreateSession('tag', {
                path: '/Users/me/project',
                host: 'studio.local',
                machineId: 'machine-1',
                flavor: 'claude',
                claudeSessionId: 'claude-123',
                name: 'Fix the build'
            }, null, 'default')
            store.sessions.updateSessionAgentState(session.id, {
                requests: { pending: { tool: 'Bash', arguments: {}, createdAt: 9_000 } },
                completedRequests: {
                    asked: { tool: 'AskUserQuestion', arguments: {}, createdAt: 2_000, completedAt: 4_000, status: 'approved' },
                    old: { tool: 'Bash', arguments: {}, createdAt: 100, completedAt: 200, status: 'approved' },
                    unplaced: { tool: 'Edit', arguments: {}, completedAt: 3_000, status: 'approved' }
                }
            }, session.agentStateVersion, 'default')
            store.turns.open(session.id, 'default', 1_000, 'hub_prompt')
            store.turns.close(session.id, 5_000, 'idle')
            store.turns.open(session.id, 'default', 8_000, 'agent')

            const response = await createApp(store, 'default').request('/api/activity?since=0&until=20000')
            expect(response.status).toBe(200)
            expect(response.headers.get('cache-control')).toBe('no-store')
            const body = await response.json() as AgentActivityResponse
            expect(body.since).toBe(0)
            expect(body.until).toBe(20_000)
            expect(body.sessions).toHaveLength(1)
            expect(body.sessions[0]).toMatchObject({
                id: session.id,
                flavor: 'claude',
                agentSessionId: 'claude-123',
                machineId: 'machine-1',
                host: 'studio.local',
                machineName: 'Studio',
                path: '/Users/me/project',
                title: 'Fix the build',
                turns: [
                    { start: 1_000, end: 5_000, endReason: 'idle', startedBy: 'hub_prompt' },
                    { start: 8_000, end: null, endReason: null, startedBy: 'agent' }
                ],
                waits: [
                    { start: 2_000, end: 4_000, kind: 'input', tool: 'AskUserQuestion' },
                    { start: 9_000, end: null, kind: 'permission', tool: 'Bash' }
                ]
            })
        } finally {
            store.close()
        }
    })

    it('only shows the caller\'s namespace', async () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('tag', { path: '/tmp', host: 'mac' }, null, 'tenant')
            store.turns.open(session.id, 'tenant', 1_000, 'agent')

            const owner = await (await createApp(store, 'default').request('/api/activity?since=0&until=20000')).json() as AgentActivityResponse
            const tenant = await (await createApp(store, 'tenant').request('/api/activity?since=0&until=20000')).json() as AgentActivityResponse
            expect(owner.sessions).toEqual([])
            expect(tenant.sessions.map((s) => s.id)).toEqual([session.id])
        } finally {
            store.close()
        }
    })

    it('defaults to the last day and rejects bad windows', async () => {
        const store = new Store(':memory:')
        try {
            const app = createApp(store, 'default')
            const body = await (await app.request('/api/activity')).json() as AgentActivityResponse
            expect(body.until - body.since).toBe(24 * 60 * 60 * 1000)

            for (const query of ['since=abc', 'since=-5', 'since=10&until=10', `since=0&until=${32 * 24 * 60 * 60 * 1000}`]) {
                expect((await app.request(`/api/activity?${query}`)).status).toBe(400)
            }
        } finally {
            store.close()
        }
    })
})
