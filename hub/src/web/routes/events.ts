import { Hono } from 'hono'
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

const visibilitySchema = z.object({
    subscriptionId: z.string().min(1),
    visibility: z.enum(['visible', 'hidden'])
})

const encoder = new TextEncoder()

function formatSSE(data: string): Uint8Array {
    return encoder.encode(`data: ${data}\n\n`)
}

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

        if (sessionId || machineId) {
            const engine = getSyncEngine()
            if (!engine) {
                return c.json({ error: 'Not connected' }, 503)
            }
            if (sessionId) {
                const sessionResult = requireSession(c, engine, sessionId)
                if (sessionResult instanceof Response) {
                    return sessionResult
                }
                resolvedSessionId = sessionResult.sessionId
            }
            if (machineId) {
                const machine = engine.getMachine(machineId)
                if (!machine) {
                    return c.json({ error: 'Machine not found' }, 404)
                }
                if (machine.namespace !== namespace) {
                    return c.json({ error: 'Machine access denied' }, 403)
                }
            }
        }

        // Use a direct push-based ReadableStream instead of Hono's streamSSE
        // which wraps through TransformStream and can cause buffering delays in Bun.
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
        let closed = false

        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                streamController = controller

                manager.subscribe({
                    id: subscriptionId,
                    namespace,
                    all,
                    sessionId: resolvedSessionId,
                    machineId,
                    visibility,
                    send: (event) => {
                        if (closed) return
                        try {
                            controller.enqueue(formatSSE(JSON.stringify(event)))
                        } catch {
                            // Stream closed
                        }
                    },
                    sendHeartbeat: () => {
                        if (closed) return
                        try {
                            controller.enqueue(formatSSE(JSON.stringify({
                                type: 'heartbeat',
                                namespace,
                                data: { timestamp: Date.now() }
                            })))
                        } catch {
                            // Stream closed
                        }
                    }
                })

                // Send initial connection event
                try {
                    controller.enqueue(formatSSE(JSON.stringify({
                        type: 'connection-changed',
                        data: { status: 'connected', subscriptionId }
                    })))
                } catch {
                    // Stream closed
                }
            },
            cancel() {
                closed = true
                streamController = null
                manager.unsubscribe(subscriptionId)
            }
        })

        // Also handle request abort
        c.req.raw.signal.addEventListener('abort', () => {
            closed = true
            manager.unsubscribe(subscriptionId)
            try {
                streamController?.close()
            } catch {
                // Already closed
            }
            streamController = null
        }, { once: true })

        return new Response(body, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            }
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
