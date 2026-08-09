import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
    WORK_GRAPH_MAX_BODY_BYTES,
    WorkGraphEventCreateSchema,
    WorkGraphEventLinkCreateSchema,
    principalMatchesAuthenticatedOwner
} from '@hapi/protocol'
import type { Store } from '../../store'
import {
    WorkGraphNotFoundError,
    WorkGraphPrincipalError,
    WorkGraphValidationError
} from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const workGraphBodyLimit = bodyLimit({
    maxSize: WORK_GRAPH_MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'Request body too large' }, 413)
})

/**
 * Minimal HTTP surface for the A2A work-graph ledger (P1 / #1374).
 * Path is intentionally NOT `/api/events` — that route is the SSE stream.
 */
export function createWorkGraphRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/work-graph/events', workGraphBodyLimit, async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = WorkGraphEventCreateSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const namespace = c.get('namespace')
        const userId = c.get('userId')
        if (!principalMatchesAuthenticatedOwner(parsed.data.principal, userId)) {
            return c.json({
                error: 'Principal must resolve to the authenticated hub owner'
            }, 403)
        }

        try {
            const result = store.workGraph.insertEvent(namespace, parsed.data)
            return c.json({
                event: result.event,
                inserted: result.inserted
            }, result.inserted ? 201 : 200)
        } catch (error) {
            if (error instanceof WorkGraphPrincipalError) {
                return c.json({ error: error.message, code: error.code }, 403)
            }
            if (error instanceof WorkGraphValidationError) {
                return c.json({ error: error.message, code: error.code }, 400)
            }
            throw error
        }
    })

    app.get('/work-graph/events', (c) => {
        const namespace = c.get('namespace')
        const relatedSessionId = c.req.query('related_session_id')
        if (!relatedSessionId) {
            return c.json({ error: 'related_session_id query parameter is required' }, 400)
        }
        const limitRaw = c.req.query('limit')
        const limit = limitRaw ? Number(limitRaw) : undefined
        // Integer only — fractional LIMIT (e.g. 1.5) is a SQLite error → 500.
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
            return c.json({ error: 'Invalid limit' }, 400)
        }
        const events = store.workGraph.listByRelatedSession(namespace, relatedSessionId, { limit })
        c.header('Cache-Control', 'no-store')
        return c.json({ events })
    })

    app.get('/work-graph/events/:eventId', (c) => {
        const namespace = c.get('namespace')
        const eventId = c.req.param('eventId')
        const event = store.workGraph.getEvent(eventId, namespace)
        if (!event) {
            return c.json({ error: 'Event not found' }, 404)
        }
        c.header('Cache-Control', 'no-store')
        return c.json({ event })
    })

    app.post('/work-graph/event-links', workGraphBodyLimit, async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = WorkGraphEventLinkCreateSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const namespace = c.get('namespace')
        try {
            const link = store.workGraph.insertLink(namespace, parsed.data)
            return c.json({ link }, 201)
        } catch (error) {
            if (error instanceof WorkGraphNotFoundError) {
                return c.json({ error: error.message, code: error.code }, 404)
            }
            throw error
        }
    })

    app.get('/work-graph/events/:eventId/links', (c) => {
        const namespace = c.get('namespace')
        const eventId = c.req.param('eventId')
        const event = store.workGraph.getEvent(eventId, namespace)
        if (!event) {
            return c.json({ error: 'Event not found' }, 404)
        }
        const links = store.workGraph.listLinksForEvent(namespace, eventId)
        c.header('Cache-Control', 'no-store')
        return c.json({ links })
    })

    return app
}
