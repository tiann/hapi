import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SSEManager } from '../../sse/sseManager'
import type { SyncEngine } from '../../sync/syncEngine'
import type { VisibilityState } from '../../visibility/visibilityTracker'
import type { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { WebAppEnv } from '../middleware/auth'
import { requireSession } from './guards'

function parseOptionalId(value: string | undefined): string | null {
    if (!value) {
        return null
    }
    return value.trim() ? value : null
}

function parseBoolean(value: string | undefined): boolean {
    if (!value) {
        return false
    }
    return value === 'true' || value === '1'
}

function parseVisibility(value: string | undefined): VisibilityState {
    return value === 'visible' ? 'visible' : 'hidden'
}

type TerminalRejection = {
    reason: 'session-not-found' | 'session-access-denied' | 'machine-not-found' | 'machine-access-denied' | 'too-many-subscriptions'
}

const visibilitySchema = z.object({
    subscriptionId: z.string().min(1),
    visibility: z.enum(['visible', 'hidden'])
})

export function createEventsRoutes(
    getSseManager: () => SSEManager | null,
    getSyncEngine: () => SyncEngine | null,
    getVisibilityTracker: () => VisibilityTracker | null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/events', (c) => {
        const manager = getSseManager()
        if (!manager) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const query = c.req.query()
        const all = parseBoolean(query.all)
        const sessionId = parseOptionalId(query.sessionId)
        const machineId = parseOptionalId(query.machineId)
        const subscriptionId = randomUUID()
        const visibility = parseVisibility(query.visibility)
        const namespace = c.get('namespace')
        let resolvedSessionId = sessionId
        let terminalRejection: TerminalRejection | null = null

        if (!manager.canAcceptSubscription(namespace)) {
            terminalRejection = { reason: 'too-many-subscriptions' }
        }

        if (!terminalRejection && (sessionId || machineId)) {
            const engine = getSyncEngine()
            if (!engine) {
                return c.json({ error: 'Not connected' }, 503)
            }
            if (sessionId) {
                const sessionResult = requireSession(c, engine, sessionId)
                if (sessionResult instanceof Response) {
                    terminalRejection = {
                        reason: sessionResult.status === 403 ? 'session-access-denied' : 'session-not-found'
                    }
                } else {
                    resolvedSessionId = sessionResult.sessionId
                }
            }
            if (machineId) {
                const machine = engine.getMachine(machineId)
                if (!machine) {
                    terminalRejection = { reason: 'machine-not-found' }
                } else if (machine.namespace !== namespace) {
                    terminalRejection = { reason: 'machine-access-denied' }
                }
            }
        }

        return streamSSE(c, async (stream) => {
            if (terminalRejection) {
                await stream.writeSSE({
                    data: JSON.stringify({
                        type: 'connection-changed',
                        namespace,
                        data: {
                            status: 'rejected',
                            reason: terminalRejection.reason
                        }
                    })
                })
                return
            }

            const subscription = manager.subscribe({
                id: subscriptionId,
                namespace,
                all,
                sessionId: resolvedSessionId,
                machineId,
                visibility,
                send: (event) => stream.writeSSE({ data: JSON.stringify(event) }),
                sendHeartbeat: async () => {
                    await stream.writeSSE({
                        data: JSON.stringify({
                            type: 'heartbeat',
                            namespace,
                            data: {
                                timestamp: Date.now()
                            }
                        })
                    })
                }
            })

            if (!subscription) {
                await stream.writeSSE({
                    data: JSON.stringify({
                        type: 'connection-changed',
                        namespace,
                        data: {
                            status: 'rejected',
                            reason: 'too-many-subscriptions'
                        }
                    })
                })
                return
            }

            await stream.writeSSE({
                data: JSON.stringify({
                    type: 'connection-changed',
                    data: {
                        status: 'connected',
                        subscriptionId
                    }
                })
            })

            await new Promise<void>((resolve) => {
                const done = () => resolve()
                c.req.raw.signal.addEventListener('abort', done, { once: true })
                stream.onAbort(done)
            })

            manager.unsubscribe(subscriptionId)
        })
    })

    app.post('/visibility', async (c) => {
        const tracker = getVisibilityTracker()
        if (!tracker) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = visibilitySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const updated = tracker.setVisibility(parsed.data.subscriptionId, namespace, parsed.data.visibility)
        if (!updated) {
            return c.json({ error: 'Subscription not found' }, 404)
        }

        return c.json({ ok: true })
    })

    return app
}
