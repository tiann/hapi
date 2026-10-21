import { Hono } from 'hono'
import { SessionReadUpdateSchema } from '@hapi/protocol'
import type { Store } from '../../store'
import type { SSEManager } from '../../sse/sseManager'
import type { WebAppEnv } from '../middleware/auth'

export function createSessionReadsRoutes(store: Store, getSseManager: () => SSEManager | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/session-read-state', c => c.json({ states: store.sessionReads.list(c.get('namespace')) }))

    app.post('/session-read-state', async c => {
        const parsed = SessionReadUpdateSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid read-state request' }, 400)
        const namespace = c.get('namespace')
        try {
            const result = store.sessionReads.update(namespace, parsed.data.mutations)
            const states = result.states.filter(state => result.acceptedSessionIds.includes(state.sessionId))
            if (states.length > 0) {
                getSseManager()?.broadcast({ type: 'session-read-state-updated', namespace, states })
            }
            return c.json(result)
        } catch (error) {
            if (error instanceof Error && error.message === 'session-not-found') {
                return c.json({ error: 'Session not found' }, 404)
            }
            if (error instanceof Error && error.message === 'future-activity') {
                return c.json({ error: 'Read position exceeds session activity' }, 400)
            }
            throw error
        }
    })
    return app
}
