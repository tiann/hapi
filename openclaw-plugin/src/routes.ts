import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry'
import type { HapiCallbackEvent, OpenClawAdapterRuntime, PluginCommandAck, PluginHealthStatus } from './types'
import { HapiCallbackClient } from './hapiClient'
import { OPENCLAW_PLUGIN_VERSION } from './pluginId'
import { ConversationBusyError } from './openclawAdapter'
import { adapterState } from './adapterState'

type RouteDeps = {
    sharedSecret: string
    namespace: string
    callbackClient: HapiCallbackClient
    runtime: OpenClawAdapterRuntime
    idempotencyCache: Map<string, PluginCommandAck>
    idempotencyTtlMs?: number
    callbackRetryBaseDelayMs?: number
    prototypeCaptureSessionKey?: string | null
    prototypeCaptureFileName?: string
    logger: PluginLogger
}

const IDEMPOTENCY_TTL_MS = 5 * 60_000
const CALLBACK_RETRY_ATTEMPTS = 3
const CALLBACK_RETRY_BASE_DELAY_MS = 1000

function isAuthorized(req: Request, sharedSecret: string): boolean {
    const header = req.headers.get('authorization')?.trim()
    return header === `Bearer ${sharedSecret}`
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
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
    const idempotencyTtlMs = deps.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS
    const callbackRetryBaseDelayMs = deps.callbackRetryBaseDelayMs ?? CALLBACK_RETRY_BASE_DELAY_MS

    const rememberAck = (idempotencyKey: string, ack: PluginCommandAck) => {
        deps.idempotencyCache.set(idempotencyKey, ack)
        setTimeout(() => {
            deps.idempotencyCache.delete(idempotencyKey)
        }, idempotencyTtlMs)
    }

    const dispatchMaybeEventsWithRetry = async (input: {
        kind: 'approve' | 'deny'
        conversationId: string
        requestId: string
        events: HapiCallbackEvent[] | void
    }): Promise<void> => {
        for (let attempt = 0; attempt < CALLBACK_RETRY_ATTEMPTS; attempt += 1) {
            try {
                await dispatchMaybeEvents(deps.callbackClient, input.events)
                return
            } catch (error) {
                if (attempt === CALLBACK_RETRY_ATTEMPTS - 1) {
                    deps.logger.error(
                        `[${deps.namespace}] hapi-openclaw ${input.kind} callback failed `
                        + `conversation=${input.conversationId} requestId=${input.requestId}: ${formatError(error)}`
                    )
                    return
                }
                await delay(callbackRetryBaseDelayMs * (attempt + 1))
            }
        }
    }

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

    const queueApprovalTask = (input: {
        kind: 'approve' | 'deny'
        conversationId: string
        requestId: string
        idempotencyKey: string
    }) => {
        queueMicrotask(() => {
            void (async () => {
                let events: HapiCallbackEvent[] | void
                try {
                    events = input.kind === 'approve'
                        ? await deps.runtime.approve({
                            kind: 'approve',
                            conversationId: input.conversationId,
                            requestId: input.requestId
                        })
                        : await deps.runtime.deny({
                            kind: 'deny',
                            conversationId: input.conversationId,
                            requestId: input.requestId
                        })
                } catch (error) {
                    deps.idempotencyCache.delete(input.idempotencyKey)
                    deps.logger.error(
                        `[${deps.namespace}] hapi-openclaw ${input.kind} task failed `
                        + `conversation=${input.conversationId} requestId=${input.requestId}: ${formatError(error)}`
                    )
                    return
                }

                await dispatchMaybeEventsWithRetry({
                    kind: input.kind,
                    conversationId: input.conversationId,
                    requestId: input.requestId,
                    events
                })
            })()
        })
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

        if (!adapterState.startRun(body.conversationId)) {
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
        rememberAck(idempotencyKey, ack)
        deps.logger.info(`[${deps.namespace}] hapi-openclaw accepted send-message conversation=${body.conversationId} localMessageId=${body.localMessageId}`)

        queueMicrotask(() => {
            void deps.runtime.sendMessageReserved({
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
                    + formatError(error)
                )
            }).finally(() => {
                adapterState.finishRun(body.conversationId!)
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
        rememberAck(idempotencyKey, ack)

        queueApprovalTask({
            kind: 'approve',
            conversationId: body.conversationId,
            requestId,
            idempotencyKey
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
        rememberAck(idempotencyKey, ack)

        queueApprovalTask({
            kind: 'deny',
            conversationId: body.conversationId,
            requestId,
            idempotencyKey
        })

        return c.json(ack)
    }

    app.post('/hapi/channel/conversations/default', ensureDefaultConversationHandler)

    app.post('/hapi/channel/messages', sendMessageHandler)

    app.post('/hapi/channel/approvals/:requestId/approve', approveHandler)

    app.post('/hapi/channel/approvals/:requestId/deny', denyHandler)

    return app
}
