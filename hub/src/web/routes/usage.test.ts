import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createUsageRoutes } from './usage'

function createApp(store: Store, namespace: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createUsageRoutes(store))
    return app
}

describe('GET /api/usage/summary', () => {
    it('returns a no-store summary for the hub owner', async () => {
        const store = new Store(':memory:')
        try {
            const response = await createApp(store, 'default').request('/api/usage/summary?range=30d')

            expect(response.status).toBe(200)
            expect(response.headers.get('cache-control')).toBe('no-store')
            const body = await response.json() as { range: { from: number | null; to: number | null }; totals: { requests: number } }
            expect(typeof body.range.from).toBe('number')
            expect(typeof body.range.to).toBe('number')
            expect(body.totals.requests).toBe(0)
        } finally {
            store.close()
        }
    })

    it('rejects non-default namespaces', async () => {
        const store = new Store(':memory:')
        try {
            const response = await createApp(store, 'tenant').request('/api/usage/summary')

            expect(response.status).toBe(403)
            expect(await response.json()).toEqual({ error: 'Usage summary is only available to the hub owner' })
        } finally {
            store.close()
        }
    })

    it('validates IANA time zones', async () => {
        const store = new Store(':memory:')
        try {
            for (const timeZone of ['America/New_York', 'Asia/Shanghai']) {
                const response = await createApp(store, 'default').request(`/api/usage/summary?timeZone=${encodeURIComponent(timeZone)}`)
                expect(response.status).toBe(200)
            }
            for (const timeZone of ['Mars/Olympus', 'x'.repeat(101)]) {
                const response = await createApp(store, 'default').request(`/api/usage/summary?timeZone=${encodeURIComponent(timeZone)}`)
                expect(response.status).toBe(400)
            }
        } finally {
            store.close()
        }
    })

    it('returns CLI account quotas across online machines on GET /api/usage/quotas', async () => {
        const store = new Store(':memory:')
        try {
            const fakeSyncEngine = {
                getOnlineMachinesByNamespace: () => [
                    {
                        id: 'machine-1',
                        active: true,
                        metadata: {
                            displayName: 'Dev Box',
                            host: 'dev-host',
                            capabilities: [MACHINE_CAPABILITIES.AgentQuotas]
                        }
                    }
                ],
                getAgentQuotas: async (_machineId: string, opts?: { refresh?: boolean }) => ({
                    fetchedAt: 1700000000000,
                    accounts: [
                        {
                            agent: 'codex' as const,
                            available: true,
                            status: 'ok' as const,
                            accountLabel: 'user@example.com',
                            planLabel: opts?.refresh ? 'Pro (Refreshed)' : 'Pro',
                            buckets: [
                                {
                                    id: 'codex-primary',
                                    label: 'Weekly (7d)',
                                    group: null,
                                    window: 'weekly',
                                    usedPercent: 18,
                                    remainingPercent: 82,
                                    resetsAt: 1700600000000
                                }
                            ],
                            updatedAt: 1700000000000
                        }
                    ]
                })
            }

            const app = new Hono<WebAppEnv>()
            app.use('*', async (c, next) => {
                c.set('namespace', 'default')
                await next()
            })
            app.route('/api', createUsageRoutes(store, () => fakeSyncEngine as never))

            const response = await app.request('/api/usage/quotas?refresh=1')
            expect(response.status).toBe(200)
            const body = await response.json() as { machines: Array<{ machineId: string; machineName: string | null; accounts: Array<{ planLabel?: string }> }> }
            expect(body.machines).toHaveLength(1)
            expect(body.machines[0]?.machineId).toBe('machine-1')
            expect(body.machines[0]?.machineName).toBe('Dev Box')
            expect(body.machines[0]?.accounts[0]?.planLabel).toBe('Pro (Refreshed)')
        } finally {
            store.close()
        }
    })
})
