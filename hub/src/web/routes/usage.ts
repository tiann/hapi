import { Hono } from 'hono'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import type {
    UsageMachineQuotasEntry,
    UsageQuotasResponse,
    UsageSummaryResponse
} from '@hapi/protocol/apiTypes'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import { getUsageSummary } from '../../sync/usageService'

export function createUsageRoutes(
    store: Store,
    getSyncEngine?: () => SyncEngine | null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/usage/summary', (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: 'Usage summary is only available to the hub owner' }, 403)
        }
        const range = c.req.query('range')
        const timeZone = c.req.query('timeZone') ?? 'UTC'
        if (timeZone.length > 100) {
            return c.json({ error: 'Invalid timeZone' }, 400)
        }
        try {
            new Intl.DateTimeFormat('en-US', { timeZone })
        } catch {
            return c.json({ error: 'Invalid timeZone' }, 400)
        }
        const response: UsageSummaryResponse = getUsageSummary(store, c.get('namespace'), range, timeZone)
        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    app.get('/usage/quotas', async (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: 'Usage quotas are only available to the hub owner' }, 403)
        }
        const engine = getSyncEngine?.() ?? null
        const updatedAt = Date.now()
        if (!engine) {
            const emptyResponse: UsageQuotasResponse = { machines: [], updatedAt }
            c.header('Cache-Control', 'no-store')
            return c.json(emptyResponse)
        }

        const refreshQuery = c.req.query('refresh')
        const refresh = refreshQuery === '1' || refreshQuery === 'true'
        const onlineMachines = engine.getOnlineMachinesByNamespace('default')

        const machines: UsageMachineQuotasEntry[] = await Promise.all(
            onlineMachines.map(async (machine): Promise<UsageMachineQuotasEntry> => {
                const machineName = machine.metadata?.displayName?.trim()
                    || machine.metadata?.host?.trim()
                    || machine.id
                const supported = Boolean(machine.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.AgentQuotas))
                if (!supported) {
                    return {
                        machineId: machine.id,
                        machineName,
                        supported: false,
                        accounts: [],
                        fetchedAt: null
                    }
                }
                try {
                    const result = await engine.getAgentQuotas(machine.id, { refresh })
                    return {
                        machineId: machine.id,
                        machineName,
                        supported: true,
                        accounts: result.accounts,
                        fetchedAt: result.fetchedAt
                    }
                } catch (error) {
                    return {
                        machineId: machine.id,
                        machineName,
                        supported: true,
                        accounts: [],
                        fetchedAt: null,
                        error: error instanceof Error ? error.message : 'Failed to fetch quotas'
                    }
                }
            })
        )

        const response: UsageQuotasResponse = {
            machines,
            updatedAt: Date.now()
        }
        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    return app
}
