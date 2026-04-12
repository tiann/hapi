import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry'
import type { HapiCallbackEvent, OpenClawAdapterRuntime, PluginCommandAck, PluginHealthStatus } from './types'
import { HapiCallbackClient } from './hapiClient'
import { OPENCLAW_PLUGIN_VERSION } from './pluginId'
import { ConversationBusyError } from './openclawAdapter'

type RouteDeps = {
    sharedSecret: string
    namespace: string
    callbackClient: HapiCallbackClient
    runtime: OpenClawAdapterRuntime
    idempotencyCache: Map<string, PluginCommandAck>
    prototypeCaptureSessionKey?: string | null
    prototypeCaptureFileName?: string
    logger: PluginLogger
}

function isAuthorized(req: Request, sharedSecret: string): boolean {
    const header = req.headers.get('authorization')?.trim()
    return header === `Bearer ${sharedSecret}`
}

async function dispatchEvents(callbackClient: HapiCallbackClient, events: HapiCallbackEvent[]): Promise<void> {
    for (const event of events) {
        await callbackClient.postEvent(event)
    }
}

async function dispatchMaybeEvents(
    callbackClient: HapiCallbackClient,
    maybeEvents: HapiCallbackEvent[] | void
): Promise<void> {
    if (!maybeEvents || maybeEvents.length === 0) {
        return
    }

    await dispatchEvents(callbackClient, maybeEvents)
}

export function createPluginApp(deps: RouteDeps): Hono {
    const app = new Hono()

    const healthHandler = (c: Context) => {
        const status: PluginHealthStatus = {
            ok: true,
            pluginVersion: OPENCLAW_PLUGIN_VERSION,
            openclawConnected: true,
            prototypeCapture: {
                enabled: Boolean(deps.prototypeCaptureSessionKey),
                sessionKey: deps.prototypeCaptureSessionKey ?? null,
                fileName: deps.prototypeCaptureFileName ?? 'transcript-capture.jsonl'
            }
        }
        return c.json(status)
    }

    const authMiddleware = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
        if (!isAuthorized(c.req.raw, deps.sharedSecret)) {
            return c.json({ error: 'Unauthorized' }, 401)
        }
        return await next()
    }

    app.get('/hapi/health', healthHandler)
    app.get('/hapi/debug/transcript-capture', healthHandler)

    app.use('/hapi/channel/*', authMiddleware)

    const ensureDefaultConversationHandler = async (c: Context) => {
        const body = await c.req.json().catch(() => null) as { externalUserKey?: string } | null
        if (!body?.externalUserKey) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        return c.json(await deps.runtime.ensureDefaultConversation(body.externalUserKey))
    }

    const sendMessageHandler = async (c: Context) => {
        const idempotencyKey = c.req.header('idempotency-key')
        if (!idempotencyKey) {
            return c.json({ error: 'Missing idempotency-key' }, 400)
        }

        const cached = deps.idempotencyCache.get(idempotencyKey)
        if (cached) {
            return c.json(cached)
        }

        const body = await c.req.json().catch(() => null) as {
            conversationId?: string
            text?: string
            localMessageId?: string
        } | null
        if (!body?.conversationId || typeof body.text !== 'string' || !body.localMessageId) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        if (deps.runtime.isConversationBusy?.(body.conversationId)) {
            return c.json({
                error: 'Conversation already has an active OpenClaw run',
                retryAfterMs: 1000
            }, 409)
        }

        const ack: PluginCommandAck = {
            accepted: true,
            upstreamRequestId: `plugin-send:${randomUUID()}`,
            upstreamConversationId: body.conversationId,
            retryAfterMs: null
        }
        deps.idempotencyCache.set(idempotencyKey, ack)
        deps.logger.info(`[${deps.namespace}] hapi-openclaw accepted send-message conversation=${body.conversationId} localMessageId=${body.localMessageId}`)

        queueMicrotask(() => {
            void deps.runtime.sendMessage({
                kind: 'send-message',
                conversationId: body.conversationId!,
                text: body.text!,
                localMessageId: body.localMessageId!
            }).then(async (events) => {
                await dispatchMaybeEvents(deps.callbackClient, events)
            }).catch((error) => {
                if (error instanceof ConversationBusyError) {
                    deps.logger.warn(`[${deps.namespace}] hapi-openclaw conversation busy conversation=${body.conversationId}`)
                    return
                }
                deps.logger.error(
                    `[${deps.namespace}] hapi-openclaw send-message task failed conversation=${body.conversationId}: `
                    + (error instanceof Error ? error.message : String(error))
                )
            })
        })

        return c.json(ack)
    }

    const approveHandler = async (c: Context) => {
        if (!deps.runtime.supportsApprovals) {
            return c.json({ error: 'OpenClaw approval bridge is not implemented yet' }, 501)
        }

        const requestId = c.req.param('requestId')
        if (!requestId) {
            return c.json({ error: 'Missing route parameter: requestId' }, 400)
        }

        const idempotencyKey = c.req.header('idempotency-key')
        if (!idempotencyKey) {
            return c.json({ error: 'Missing idempotency-key' }, 400)
        }

        const cached = deps.idempotencyCache.get(idempotencyKey)
        if (cached) {
            return c.json(cached)
        }

        const body = await c.req.json().catch(() => null) as { conversationId?: string } | null
        if (!body?.conversationId) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const ack: PluginCommandAck = {
            accepted: true,
            upstreamRequestId: `plugin-approve:${randomUUID()}`,
            upstreamConversationId: body.conversationId,
            retryAfterMs: null
        }
        deps.idempotencyCache.set(idempotencyKey, ack)

        queueMicrotask(() => {
            void deps.runtime.approve({
                kind: 'approve',
                conversationId: body.conversationId!,
                requestId
            }).then(async (events) => {
                await dispatchMaybeEvents(deps.callbackClient, events)
            }).catch(() => {})
        })

        return c.json(ack)
    }

    const denyHandler = async (c: Context) => {
        if (!deps.runtime.supportsApprovals) {
            return c.json({ error: 'OpenClaw approval bridge is not implemented yet' }, 501)
        }

        const requestId = c.req.param('requestId')
        if (!requestId) {
            return c.json({ error: 'Missing route parameter: requestId' }, 400)
        }

        const idempotencyKey = c.req.header('idempotency-key')
        if (!idempotencyKey) {
            return c.json({ error: 'Missing idempotency-key' }, 400)
        }

        const cached = deps.idempotencyCache.get(idempotencyKey)
        if (cached) {
            return c.json(cached)
        }

        const body = await c.req.json().catch(() => null) as { conversationId?: string } | null
        if (!body?.conversationId) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const ack: PluginCommandAck = {
            accepted: true,
            upstreamRequestId: `plugin-deny:${randomUUID()}`,
            upstreamConversationId: body.conversationId,
            retryAfterMs: null
        }
        deps.idempotencyCache.set(idempotencyKey, ack)

        queueMicrotask(() => {
            void deps.runtime.deny({
                kind: 'deny',
                conversationId: body.conversationId!,
                requestId
            }).then(async (events) => {
                await dispatchMaybeEvents(deps.callbackClient, events)
            }).catch(() => {})
        })

        return c.json(ack)
    }

    app.post('/hapi/channel/conversations/default', ensureDefaultConversationHandler)

    app.post('/hapi/channel/messages', sendMessageHandler)

    app.post('/hapi/channel/approvals/:requestId/approve', approveHandler)

    app.post('/hapi/channel/approvals/:requestId/deny', denyHandler)

    return app
}
