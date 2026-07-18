import { Hono, type MiddlewareHandler } from 'hono'
import { getExecutionControl, isCodexDesktopMirrorSession } from '@hapi/protocol'
import { AttachmentMetadataSchema } from '@hapi/protocol/schemas'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    beforeSeq: z.coerce.number().int().min(1).optional(),
    afterSeq: z.coerce.number().int().min(0).optional(),
    markRead: z.enum(['true', '1']).optional()
}).refine(
    (query) => !(query.beforeSeq !== undefined && query.afterSeq !== undefined),
    { message: 'beforeSeq and afterSeq are mutually exclusive' },
)

const recentUserMessagesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(10).optional()
})

export const SEND_MESSAGE_MAX_BODY_BYTES = 16 * 1024 * 1024
export const SEND_MESSAGE_MAX_ATTACHMENTS = 16
const SEND_MESSAGE_MAX_TEXT_CHARS = 1_000_000
const SEND_MESSAGE_MAX_ID_CHARS = 512
const SEND_MESSAGE_MAX_FILENAME_CHARS = 255
const SEND_MESSAGE_MAX_MIME_CHARS = 255
const SEND_MESSAGE_MAX_PATH_CHARS = 4_096
const SEND_MESSAGE_MAX_PREVIEW_URL_CHARS = 7_000_000
const SEND_MESSAGE_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

const enforceSendMessageBodyLimit: MiddlewareHandler<WebAppEnv> = async (c, next) => {
    const contentLength = c.req.raw.headers.get('content-length')
    if (contentLength !== null) {
        const declaredBytes = Number(contentLength)
        if (Number.isSafeInteger(declaredBytes) && declaredBytes > SEND_MESSAGE_MAX_BODY_BYTES) {
            return c.json({ error: 'Request body too large' }, 413)
        }
    }

    const body = c.req.raw.body
    if (!body) {
        return next()
    }

    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let actualBytes = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        actualBytes += value.byteLength
        if (actualBytes > SEND_MESSAGE_MAX_BODY_BYTES) {
            await reader.cancel().catch(() => undefined)
            return c.json({ error: 'Request body too large' }, 413)
        }
        chunks.push(value)
    }

    c.req.raw = new Request(c.req.raw, {
        body: new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk)
                controller.close()
            },
        }),
        duplex: 'half',
    })
    return next()
}

const sendAttachmentSchema = AttachmentMetadataSchema.extend({
    id: z.string().min(1).max(SEND_MESSAGE_MAX_ID_CHARS),
    filename: z.string().min(1).max(SEND_MESSAGE_MAX_FILENAME_CHARS),
    mimeType: z.string().min(1).max(SEND_MESSAGE_MAX_MIME_CHARS),
    size: z.number().int().min(0).max(SEND_MESSAGE_MAX_ATTACHMENT_BYTES),
    path: z.string().min(1).max(SEND_MESSAGE_MAX_PATH_CHARS),
    previewUrl: z.string().max(SEND_MESSAGE_MAX_PREVIEW_URL_CHARS).optional(),
})

const sendMessageBodySchema = z.object({
    text: z.string().max(SEND_MESSAGE_MAX_TEXT_CHARS),
    localId: z.string().min(1).max(SEND_MESSAGE_MAX_ID_CHARS).optional(),
    attachments: z.array(sendAttachmentSchema).max(SEND_MESSAGE_MAX_ATTACHMENTS).optional(),
}).strict()

function sessionStartStatus(code: string): 403 | 404 | 409 | 503 | 500 {
    if (code === 'access_denied') return 403
    if (code === 'session_not_found') return 404
    if (code === 'no_machine_online') return 503
    if (code === 'takeover_busy' || code === 'resume_unavailable') return 409
    return 500
}

export function createMessagesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/recent-user-messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const parsed = recentUserMessagesQuerySchema.safeParse(c.req.query())
        const limit = parsed.success ? (parsed.data.limit ?? 10) : 10
        return c.json({
            messages: engine.getRecentUserMessages(sessionResult.sessionId, { limit })
        })
    })

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

        const parsed = querySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({
                error: 'Invalid query',
                details: parsed.error.flatten(),
            }, 400)
        }
        const limit = parsed.data.limit ?? 50
        const beforeSeq = parsed.data.beforeSeq ?? null
        const afterSeq = parsed.data.afterSeq ?? null
        const page = engine.getMessagesPage(sessionId, { limit, beforeSeq, afterSeq })
        if (beforeSeq === null && afterSeq === null && parsed.data.markRead) {
            engine.markSessionRead(sessionId, c.get('namespace'))
        }
        return c.json(page)
    })

    app.post(
        '/sessions/:id/messages',
        enforceSendMessageBodyLimit,
        async (c) => {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) {
                return engine
            }

            const sessionResult = requireSessionFromParam(c, engine)
            if (sessionResult instanceof Response) {
                return sessionResult
            }

            const body = await c.req.json().catch(() => null)
            const parsed = sendMessageBodySchema.safeParse(body)
            if (!parsed.success) {
                return c.json({ error: 'Invalid body' }, 400)
            }

            // Require text or attachments
            if (!parsed.data.text && (!parsed.data.attachments || parsed.data.attachments.length === 0)) {
                return c.json({ error: 'Message requires text or attachments' }, 400)
            }

            const sessionId = sessionResult.sessionId
            let targetSessionId = sessionId
            const recentMessages = engine.getMessagesPage(sessionId, {
                limit: 50,
                beforeSeq: null,
                afterSeq: null,
            }).messages
            const control = getExecutionControl(sessionResult.session.metadata)
            const isDesktopMirror = isCodexDesktopMirrorSession({
                metadata: sessionResult.session.metadata,
                messages: recentMessages
            })

            if (isDesktopMirror && control?.owner !== 'hapi-runner') {
                const takeover = await engine.takeoverSession(sessionId, c.get('namespace'))
                if (takeover.type === 'error') {
                    return c.json({
                        error: takeover.message,
                        code: takeover.code
                    }, sessionStartStatus(takeover.code))
                }
                targetSessionId = takeover.sessionId
            } else if (!sessionResult.session.active) {
                const resume = await engine.resumeSession(sessionId, c.get('namespace'))
                if (resume.type === 'error') {
                    return c.json({
                        error: resume.message,
                        code: resume.code
                    }, sessionStartStatus(resume.code))
                }
                targetSessionId = resume.sessionId
            }

            await engine.sendMessage(targetSessionId, {
                text: parsed.data.text,
                localId: parsed.data.localId,
                attachments: parsed.data.attachments,
                sentFrom: 'webapp'
            })
            return c.json({ ok: true })
        },
    )

    return app
}
