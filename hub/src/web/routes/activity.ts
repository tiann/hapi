import { Hono } from 'hono'
import type { AgentActivityResponse } from '@hapi/protocol/apiTypes'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import { ACTIVITY_DEFAULT_WINDOW_MS, ACTIVITY_MAX_WINDOW_MS, getAgentActivity } from '../../sync/activityService'

/** Epoch ms from a query parameter; undefined when absent, null when invalid. */
function parseTime(value: string | undefined): number | null | undefined {
    if (value === undefined || value === '') return undefined
    if (!/^\d{1,15}$/.test(value)) return null
    return Number(value)
}

export function createActivityRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/activity', (c) => {
        const now = Date.now()
        const until = parseTime(c.req.query('until'))
        const since = parseTime(c.req.query('since'))
        if (until === null || since === null) {
            return c.json({ error: 'since and until must be epoch milliseconds' }, 400)
        }
        const end = until ?? now
        const start = since ?? end - ACTIVITY_DEFAULT_WINDOW_MS
        if (start >= end) {
            return c.json({ error: 'since must be before until' }, 400)
        }
        if (end - start > ACTIVITY_MAX_WINDOW_MS) {
            return c.json({ error: 'The window can be at most 31 days' }, 400)
        }
        const response: AgentActivityResponse = getAgentActivity(store, c.get('namespace'), start, end, now)
        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    return app
}
