import { Hono, type Context } from 'hono'
import { MessagesQuerySchema, QueuedStateRequestSchema, SendMessageRequestSchema, isHibernatedLifecycleState } from '@hapi/protocol'
import { AttachmentCheckError, HISTORY_ACTION_IN_PROGRESS_MESSAGE, type ReopenSessionResult, type ResumeSessionResult, type SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

function attachmentError(c: Context<WebAppEnv>, error: unknown): Response {
    if (!(error instanceof AttachmentCheckError)) throw error
    return c.json({ error: error.message, code: error.unavailable ? 'attachment_check_unavailable' : 'attachment_reupload_required',
        retryable: true }, error.unavailable ? 503 : 409)
}

export function createMessagesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
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
        const after = parsed.data.afterAt !== undefined && parsed.data.afterSeq !== undefined
            ? { at: parsed.data.afterAt, seq: parsed.data.afterSeq }
            : null
        const until = parsed.data.untilAt !== undefined && parsed.data.untilSeq !== undefined
            ? { at: parsed.data.untilAt, seq: parsed.data.untilSeq }
            : null
        return c.json(engine.getMessagesPage(sessionId, {
            limit,
            before,
            after,
            until,
            epoch: parsed.data.epoch ?? null
        }))
    })

    app.get('/sessions/:id/messages/:messageId/context', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        return c.json(engine.getMessageContext(sessionResult.sessionId, c.req.param('messageId')))
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

    app.post('/sessions/:id/messages/:messageId/steer', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        const messageId = c.req.param('messageId')

        const result = await engine.steerQueuedMessage(sessionId, messageId)
        return c.json(result)
    })

    app.post('/sessions/:id/messages/:messageId/retry', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        try {
            return c.json(await engine.retryIndeterminateMessage(sessionResult.sessionId, c.req.param('messageId')))
        } catch (error) {
            return attachmentError(c, error)
        }
    })

    app.post('/sessions/:id/messages/queued-state', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = QueuedStateRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const localIds = [...new Set(parsed.data.localIds)]
        if (localIds.length === 0) {
            return c.json({ queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: [] })
        }
        return c.json(engine.getQueuedState(sessionId, localIds))
    })

    app.post('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const initial = requireSessionFromParam(c, engine)
        if (initial instanceof Response) {
            return initial
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SendMessageRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        // Require text or attachments
        if (!parsed.data.text && (!parsed.data.attachments || parsed.data.attachments.length === 0)) {
            return c.json({ error: 'Message requires text or attachments' }, 400)
        }
        const payload = parsed.data
        const namespace = c.get('namespace')

        const wakeError = (result: Extract<ResumeSessionResult | ReopenSessionResult, { type: 'error' }>) => {
            const status = result.code === 'no_machine_online' ? 503
                : result.code === 'access_denied' ? 403
                    : result.code === 'session_not_found' ? 404
                        : result.code === 'resume_unavailable' ? 409
                            : 500
            return c.json({ error: result.message, code: result.code }, status)
        }

        // Resolve the delivery target: wait out an in-flight hibernation stop
        // (it holds the history lock), re-read, and wake a hibernated session
        // transparently (same id). A future scheduled send waits for its due time.
        let requireUploadValidation = false
        const resolveTarget = async (sessionId: string): Promise<string | Response> => {
            let current = requireSessionFromParam(c, engine)
            if (current instanceof Response) {
                return current
            }
            if (await engine.awaitHibernation?.(sessionId)) {
                current = requireSessionFromParam(c, engine)
                if (current instanceof Response) {
                    return current
                }
            }
            const pending = engine.pendingSessionWake?.(current.sessionId, namespace)
            if (pending) {
                requireUploadValidation = true
                const wake = await pending
                if (wake.type === 'error') return wakeError(wake)
                if (wake.type === 'incomplete') return c.json({ error: wake.message, code: 'resume_unavailable' }, 409)
                current = requireSessionFromParam(c, engine)
                if (current instanceof Response) return current
            }
            const hibernated = !current.session.active && isHibernatedLifecycleState(current.session.metadata?.lifecycleState)
            if (!current.session.active && !hibernated) {
                return c.json({ error: 'Session is inactive', code: 'session_inactive' }, 409)
            }
            const scheduledInFuture = typeof payload.scheduledAt === 'number' && payload.scheduledAt > Date.now()
            if (!hibernated || scheduledInFuture) {
                return current.sessionId
            }
            requireUploadValidation = true
            const result = await engine.resumeSession(current.sessionId, namespace)
            if (result.type === 'error') return wakeError(result)
            return result.sessionId
        }

        const send = async (sessionId: string) => {
            try {
                await engine.sendMessage(sessionId, {
                    text: payload.text,
                    localId: payload.localId,
                    attachments: payload.attachments,
                    sentFrom: 'webapp',
                    scheduledAt: payload.scheduledAt,
                    deliveryMode: payload.deliveryMode
                }, requireUploadValidation)
                return c.json({ ok: true })
            } catch (error) {
                return attachmentError(c, error)
            }
        }

        let target = await resolveTarget(initial.sessionId)
        if (target instanceof Response) {
            return target
        }
        try {
            return await send(target)
        } catch (error) {
            // A hibernation sweep can win the race between the read above and
            // the send. Wait it out and retry once through the wake branch.
            const historyBusy = error instanceof Error && error.message === HISTORY_ACTION_IN_PROGRESS_MESSAGE
            if (!historyBusy) throw error
            if (!engine.hibernationInFlight?.(target) && !engine.pendingSessionWake?.(target, namespace)) {
                const current = requireSessionFromParam(c, engine)
                if (current instanceof Response) return current
                if (current.session.active || !isHibernatedLifecycleState(current.session.metadata?.lifecycleState)) {
                    throw error
                }
            }
            target = await resolveTarget(target)
            if (target instanceof Response) {
                return target
            }
            return await send(target)
        }
    })

    return app
}
