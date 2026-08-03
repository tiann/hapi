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
        const timezoneOffsetParam = c.req.query('timezoneOffset')
        const timezoneOffset = timezoneOffsetParam === undefined ? 0 : Number(timezoneOffsetParam)
        if (!Number.isInteger(timezoneOffset) || timezoneOffset < -840 || timezoneOffset > 840) {
            return c.json({ error: 'timezoneOffset must be an integer between -840 and 840' }, 400)
        }
        const response: UsageSummaryResponse = getUsageSummary(store, c.get('namespace'), range, timezoneOffset)
        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    return app
}
