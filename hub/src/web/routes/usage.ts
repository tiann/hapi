import { Hono } from 'hono'
import type { UsageSummaryResponse } from '@hapi/protocol/apiTypes'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import { getUsageSummary } from '../../sync/usageService'

export function createUsageRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/usage/summary', (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: 'Usage summary is only available to the hub owner' }, 403)
        }
        const range = c.req.query('range')
        const response: UsageSummaryResponse = getUsageSummary(store, c.get('namespace'), range)
        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    return app
}
