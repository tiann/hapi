import { SessionManualOrderSchema, SessionSortModeSchema } from '@hapi/protocol/schemas'
import { Hono } from 'hono'
import { z } from 'zod'

import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSyncEngine } from './guards'

const setSessionSortPreferenceSchema = z.object({
    sortMode: SessionSortModeSchema,
    manualOrder: SessionManualOrderSchema,
    expectedVersion: z.number().int().positive().optional()
})

export function createPreferencesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/preferences/session-sort', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const userId = c.get('userId')
        const namespace = c.get('namespace')
        const preference = engine.getSessionSortPreference(userId, namespace)

        return c.json({ preference })
    })

    app.put('/preferences/session-sort', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = setSessionSortPreferenceSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const userId = c.get('userId')
        const namespace = c.get('namespace')
        const result = engine.setSessionSortPreference(userId, namespace, parsed.data)

        if (result.result === 'error') {
            return c.json({ error: 'Failed to save session sort preference' }, 500)
        }

        if (result.result === 'version-mismatch') {
            return c.json({ error: 'version_mismatch', preference: result.preference }, 409)
        }

        return c.json({ preference: result.preference })
    })

    return app
}
