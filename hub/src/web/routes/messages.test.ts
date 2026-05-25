/**
 * Tests for the POST /sessions/:id/messages route.
 * Public delayed-send contract is pluginAction only; legacy scheduledAt/delivery
 * request fields are intentionally rejected by the strict request schema.
 */
import { describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import type { HubPluginManager } from '../../plugins/pluginManager'
import { createMessagesRoutes } from './messages'

function createScheduleAction(notBefore: number) {
    return {
        pluginId: 'com.hapi.schedule-send',
        capabilityId: 'schedule-send',
        position: 'hub' as const,
        actionId: 'schedule-send',
        payload: { notBefore }
    }
}

function createPluginManager() {
    return {
        planMessageAction: async (args: { localId?: string; attachments: unknown[]; payload: unknown }) => {
            const payload = args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
                ? args.payload as Record<string, unknown>
                : {}
            const notBefore = payload.notBefore
            if (typeof notBefore !== 'number' || !Number.isInteger(notBefore) || notBefore <= 0) {
                return { ok: false as const, code: 'invalid-not-before', message: 'Schedule send requires payload.notBefore.' }
            }
            if (!args.localId) {
                return { ok: false as const, code: 'missing-local-id', message: 'Scheduled messages require localId.' }
            }
            if (args.attachments.length > 0) {
                return { ok: false as const, code: 'attachments-unsupported', message: 'Scheduled messages with attachments are not supported.' }
            }
            if (notBefore > Date.now() + 7 * 24 * 60 * 60 * 1000) {
                return { ok: false as const, code: 'schedule-too-far', message: 'Schedule time must be within 7 days.' }
            }
            return {
                ok: true as const,
                plan: {
                    type: 'messageDelivery' as const,
                    delivery: { notBefore },
                    source: {
                        pluginId: 'com.hapi.schedule-send',
                        capabilityId: 'schedule-send',
                        actionId: 'schedule-send'
                    }
                }
            }
        }
    } as unknown as HubPluginManager
}

function createApp(opts: {
    active?: boolean
    sendMessage?: (sessionId: string, payload: unknown) => Promise<void>
    pluginManager?: HubPluginManager | null
} = {}) {
    const sentMessages: Array<{ sessionId: string; payload: unknown }> = []
    const sendMessage = opts.sendMessage ?? (async (sessionId: string, payload: unknown) => {
        sentMessages.push({ sessionId, payload })
    })

    const engine = {
        resolveSessionAccess: () => ({
            ok: true,
            sessionId: 'session-1',
            session: { id: 'session-1', namespace: 'default', active: opts.active !== false, metadata: null }
        }),
        sendMessage,
        cancelQueuedMessage: async () => ({ status: 'cancelled' }),
        getMessagesPage: () => ({ messages: [], page: {} }),
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createMessagesRoutes(() => engine, () => opts.pluginManager ?? null))

    return { app, sentMessages }
}

describe('POST /api/sessions/:id/messages — pluginAction message plan', () => {
    it('rejects legacy scheduledAt request fields with strict schema errors', async () => {
        const { app } = createApp()
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello', localId: 'local-1', scheduledAt: Date.now() + 60_000 })
        })

        expect(response.status).toBe(400)
        const body = await response.json() as { error: string; issues?: unknown }
        expect(body.error).toBe('Invalid body')
        expect(JSON.stringify(body.issues)).toContain('scheduledAt')
    })

    it('rejects legacy delivery.notBefore request fields with strict schema errors', async () => {
        const { app } = createApp()
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello', localId: 'local-2', delivery: { notBefore: Date.now() + 60_000 } })
        })

        expect(response.status).toBe(400)
        const body = await response.json() as { error: string; issues?: unknown }
        expect(body.error).toBe('Invalid body')
        expect(JSON.stringify(body.issues)).toContain('delivery')
    })

    it('accepts a Hub pluginAction and forwards the plugin-produced delivery plan', async () => {
        const { app, sentMessages } = createApp({ pluginManager: createPluginManager() })
        const notBefore = Date.now() + 60_000
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello', localId: 'local-3', pluginAction: createScheduleAction(notBefore) })
        })

        expect(response.status).toBe(200)
        expect(sentMessages).toHaveLength(1)
        expect(sentMessages[0]?.payload).toMatchObject({
            plan: {
                type: 'messageDelivery',
                delivery: { notBefore },
                source: { pluginId: 'com.hapi.schedule-send', capabilityId: 'schedule-send', actionId: 'schedule-send' }
            }
        })
    })

    it('returns plugin handler validation errors without sending', async () => {
        const { app, sentMessages } = createApp({ pluginManager: createPluginManager() })
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello', pluginAction: createScheduleAction(Date.now() + 60_000) })
        })

        expect(response.status).toBe(400)
        const body = await response.json() as { error: string }
        expect(body.error).toContain('localId')
        expect(sentMessages).toHaveLength(0)
    })

    it('returns generic errors for unexpected plugin action failures', async () => {
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
        const pluginManager = {
            planMessageAction: async () => {
                throw new Error('secret-token-value')
            }
        } as unknown as HubPluginManager
        const { app, sentMessages } = createApp({ pluginManager })
        try {
            const response = await app.request('/api/sessions/session-1/messages', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: 'hello', localId: 'local-secret', pluginAction: createScheduleAction(Date.now() + 60_000) })
            })

            expect(response.status).toBe(500)
            const body = await response.json() as { error: string }
            expect(body.error).toBe('Plugin message action failed')
            expect(body.error).not.toContain('secret-token-value')
            expect(errorSpy).toHaveBeenCalled()
            expect(sentMessages).toHaveLength(0)
        } finally {
            errorSpy.mockRestore()
        }
    })

    it('rejects malformed Hub plugin message plans before sending', async () => {
        const pluginManager = {
            planMessageAction: async () => ({
                ok: true as const,
                plan: {
                    type: 'messageDelivery',
                    delivery: { notBefore: Date.now() + 60_000 },
                    source: { pluginId: 'com.other.plugin', actionId: 'wrong-action' }
                }
            })
        } as unknown as HubPluginManager
        const { app, sentMessages } = createApp({ pluginManager })

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello', localId: 'local-5', pluginAction: createScheduleAction(Date.now() + 60_000) })
        })

        expect(response.status).toBe(502)
        const body = await response.json() as { error: string }
        expect(body.error).toContain('source')
        expect(sentMessages).toHaveLength(0)
    })

    it('enforces delayed-message invariants on Hub plugin plans', async () => {
        const pluginManager = {
            planMessageAction: async () => ({
                ok: true as const,
                plan: {
                    type: 'messageDelivery',
                    delivery: { notBefore: Date.now() + 60_000 },
                    source: { pluginId: 'com.hapi.schedule-send', capabilityId: 'schedule-send', actionId: 'schedule-send' }
                }
            })
        } as unknown as HubPluginManager
        const { app, sentMessages } = createApp({ pluginManager })

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                text: 'hello',
                localId: 'local-6',
                attachments: [{ id: 'att-6', filename: 'a.txt', mimeType: 'text/plain', size: 1, path: '/tmp/a.txt' }],
                pluginAction: createScheduleAction(Date.now() + 60_000)
            })
        })

        expect(response.status).toBe(502)
        const body = await response.json() as { error: string }
        expect(body.error).toContain('attachments')
        expect(sentMessages).toHaveLength(0)
    })

    it('keeps immediate sends and attachments independent from schedule plugin actions', async () => {
        const { app, sentMessages } = createApp()
        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                text: 'hello',
                attachments: [{ id: 'att-2', filename: 'b.png', mimeType: 'image/png', size: 10, path: '/tmp/b.png' }]
            })
        })

        expect(response.status).toBe(200)
        expect(sentMessages).toHaveLength(1)
        expect(sentMessages[0]?.payload).toMatchObject({ plan: { type: 'immediate' } })
    })
})
