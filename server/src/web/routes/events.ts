import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import type { SSEManager } from '../../sse/sseManager'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

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

export function createEventsRoutes(
    getSseManager: () => SSEManager | null,
    getSyncEngine: () => SyncEngine | null
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
        const namespace = c.get('namespace')

        if (sessionId || machineId) {
            const engine = getSyncEngine()
            if (!engine) {
                return c.json({ error: 'Not connected' }, 503)
            }
            if (sessionId) {
                const session = engine.getSession(sessionId)
                if (!session) {
                    return c.json({ error: 'Session not found' }, 404)
                }
                if (session.namespace !== namespace) {
                    return c.json({ error: 'Session access denied' }, 403)
                }
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

        return streamSSE(c, async (stream) => {
            manager.subscribe({
                id: subscriptionId,
                namespace,
                all,
                sessionId,
                machineId,
                send: (event) => stream.writeSSE({ data: JSON.stringify(event) }),
                sendHeartbeat: async () => {
                    await stream.write(': heartbeat\n\n')
                }
            })

            await new Promise<void>((resolve) => {
                const done = () => resolve()
                c.req.raw.signal.addEventListener('abort', done, { once: true })
                stream.onAbort(done)
            })

            manager.unsubscribe(subscriptionId)
        })
    })

    return app
}
