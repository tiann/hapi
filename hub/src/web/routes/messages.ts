import { Hono } from 'hono'
import { MessagesQuerySchema, SendMessageRequestSchema, type PluginMessageActionRequest } from '@hapi/protocol'
import type { AttachmentMetadata } from '@hapi/protocol/types'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'
import type { HubPluginManager } from '../../plugins/pluginManager'
import type { MessageSendPlan } from '@hapi/protocol/plugins'

class PluginActionHttpError extends Error {
    constructor(readonly status: 400 | 404 | 409 | 502 | 503, message: string) {
        super(message)
    }
}

const MAX_PLUGIN_MESSAGE_DELAY_MS = 7 * 24 * 60 * 60 * 1000

function validateMessageSendPlan(value: unknown, args: {
    action: PluginMessageActionRequest
    localId?: string
    attachments: AttachmentMetadata[]
    now?: number
}): { ok: true; plan: MessageSendPlan } | { ok: false; message: string } {
    if (!value || typeof value !== 'object') {
        return { ok: false, message: 'Plugin message action returned an invalid message plan.' }
    }
    const record = value as Record<string, unknown>
    if (record.type === 'immediate') {
        return { ok: true, plan: { type: 'immediate' } }
    }
    if (record.type !== 'messageDelivery') {
        return { ok: false, message: 'Plugin message action returned an invalid message plan type.' }
    }
    const delivery = record.delivery
    if (!delivery || typeof delivery !== 'object') {
        return { ok: false, message: 'Plugin message action returned an invalid delivery plan.' }
    }
    const notBefore = (delivery as Record<string, unknown>).notBefore
    if (notBefore !== undefined) {
        if (typeof notBefore !== 'number' || !Number.isFinite(notBefore) || !Number.isInteger(notBefore) || notBefore <= 0) {
            return { ok: false, message: 'Plugin message action returned an invalid delivery time.' }
        }
        if (!args.localId) {
            return { ok: false, message: 'Scheduled plugin messages require localId.' }
        }
        if (args.attachments.length > 0) {
            return { ok: false, message: 'Scheduled plugin messages with attachments are not supported.' }
        }
        if (notBefore > (args.now ?? Date.now()) + MAX_PLUGIN_MESSAGE_DELAY_MS) {
            return { ok: false, message: 'Plugin message action scheduled delivery too far in the future.' }
        }
    }
    const source = record.source
    if (!source || typeof source !== 'object') {
        return { ok: false, message: 'Plugin message action returned an invalid message source.' }
    }
    const sourceRecord = source as Record<string, unknown>
    if (sourceRecord.pluginId !== args.action.pluginId || sourceRecord.actionId !== args.action.actionId) {
        return { ok: false, message: 'Plugin message action returned a message source that does not match the request.' }
    }
    if (args.action.capabilityId && sourceRecord.capabilityId !== args.action.capabilityId) {
        return { ok: false, message: 'Plugin message action returned a capability source that does not match the request.' }
    }
    return {
        ok: true,
        plan: {
            type: 'messageDelivery',
            delivery: {
                ...(notBefore !== undefined ? { notBefore } : {})
            },
            source: {
                pluginId: args.action.pluginId,
                actionId: args.action.actionId,
                ...(args.action.capabilityId ? { capabilityId: args.action.capabilityId } : {})
            },
            ...('payload' in record ? { payload: record.payload } : {})
        }
    }
}

async function resolveMessagePlan(options: {
    engine: SyncEngine
    manager: HubPluginManager | null
    namespace: string
    sessionId: string
    session: Session
    text: string
    localId?: string
    attachments: AttachmentMetadata[]
    pluginAction?: PluginMessageActionRequest
}): Promise<MessageSendPlan> {
    const action = options.pluginAction
    if (!action) {
        return { type: 'immediate' }
    }

    if (action.position === 'hub') {
        if (!options.manager) {
            throw new PluginActionHttpError(503, 'Plugin manager is not ready')
        }
        const result = await options.manager.planMessageAction({
            pluginId: action.pluginId,
            capabilityId: action.capabilityId,
            actionId: action.actionId,
            namespace: options.namespace,
            session: {
                id: options.session.id,
                namespace: options.session.namespace,
                active: options.session.active,
                metadata: options.session.metadata
            },
            text: options.text,
            localId: options.localId,
            attachments: options.attachments,
            payload: action.payload
        })
        if (!result.ok) {
            throw new PluginActionHttpError(result.code === 'plugin-action-not-active' ? 409 : 400, result.message)
        }
        const validated = validateMessageSendPlan(result.plan, {
            action,
            localId: options.localId,
            attachments: options.attachments
        })
        if (!validated.ok) {
            throw new PluginActionHttpError(502, validated.message)
        }
        return validated.plan
    }

    const machineId = typeof options.session.metadata?.machineId === 'string'
        ? options.session.metadata.machineId
        : null
    if (!machineId) {
        throw new PluginActionHttpError(409, 'Runner plugin message action requires a session with machineId metadata.')
    }
    const machine = options.engine.getMachineByNamespace(machineId, options.namespace)
    if (!machine) {
        throw new PluginActionHttpError(404, 'Runner target not found for this session.')
    }
    if (!machine.active) {
        throw new PluginActionHttpError(503, 'Runner target is offline.')
    }
    const response = await options.engine.invokeRunnerPluginAction(machine.id, {
        pluginId: action.pluginId,
        capabilityId: action.capabilityId,
        actionId: action.actionId,
        namespace: options.namespace,
        sessionId: options.sessionId,
        cwd: options.session.metadata?.path,
        payload: action.payload
    })
    if (!response.ok) {
        throw new PluginActionHttpError(response.code === 'plugin-action-not-active' ? 409 : 400, response.message)
    }
    const validated = validateMessageSendPlan(response.result, {
        action,
        localId: options.localId,
        attachments: options.attachments
    })
    if (!validated.ok) {
        throw new PluginActionHttpError(502, validated.message)
    }
    return validated.plan
}

export function createMessagesRoutes(
    getSyncEngine: () => SyncEngine | null,
    getPluginManager: () => HubPluginManager | null = () => null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const parsed = MessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', issues: parsed.error.flatten() }, 400)
        }

        const limit = parsed.data.limit ?? 50
        const before = parsed.data.beforeAt !== undefined && parsed.data.beforeSeq !== undefined
            ? { at: parsed.data.beforeAt, seq: parsed.data.beforeSeq }
            : null
        return c.json(engine.getMessagesPage(sessionId, { limit, before }))
    })

    app.delete('/sessions/:id/messages/:messageId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        const messageId = c.req.param('messageId')

        const result = await engine.cancelQueuedMessage(sessionId, messageId)
        return c.json(result)
    })

    app.post('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = SendMessageRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        // Require text or attachments
        if (!parsed.data.text && (!parsed.data.attachments || parsed.data.attachments.length === 0)) {
            return c.json({ error: 'Message requires text or attachments' }, 400)
        }

        let plan: MessageSendPlan
        try {
            plan = await resolveMessagePlan({
                engine,
                manager: getPluginManager(),
                namespace: c.get('namespace'),
                sessionId,
                session: sessionResult.session,
                text: parsed.data.text,
                localId: parsed.data.localId,
                attachments: parsed.data.attachments ?? [],
                pluginAction: parsed.data.pluginAction
            })
        } catch (error) {
            if (error instanceof PluginActionHttpError) {
                return c.json({ error: error.message }, error.status)
            }
            console.error('[messages] Plugin message action failed', error)
            return c.json({ error: 'Plugin message action failed' }, 500)
        }

        await engine.sendMessage(sessionId, {
            text: parsed.data.text,
            localId: parsed.data.localId,
            attachments: parsed.data.attachments,
            sentFrom: 'webapp',
            plan
        })
        return c.json({ ok: true })
    })

    return app
}
