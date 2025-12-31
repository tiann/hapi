import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import { LarkClient } from '../../lark/larkClient'
import { buildPermissionResultCard, type PermissionCardContext } from '../../lark/larkCardBuilder'
import type { SyncEngine } from '../../sync/syncEngine'

const larkEventSchema = z.object({
    header: z.object({
        event_type: z.string().optional(),
        token: z.string()
    }).passthrough(),
    event: z.object({
        message: z.object({
            message_id: z.string(),
            chat_id: z.string(),
            message_type: z.string(),
            content: z.string(), // JSON string
        }).passthrough(),
        sender: z.object({
            sender_id: z.object({
                open_id: z.string(),
            }).passthrough(),
        }).passthrough(),
    }).optional(),
    action: z.object({
        value: z.any()
    }).optional(),
    open_message_id: z.string().optional(),
    challenge: z.string().optional(),
    type: z.string().optional() // url_verification
}).passthrough()

export function createLarkWebhookRoutes(options: {
    getSyncEngine: () => SyncEngine | null
    verificationToken: string | null
    appId: string | null
    appSecret: string | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Health check for external callback verification.
    app.get('/lark/webhook', (c) => {
        return c.json({ ok: true })
    })

    /**
     * Lark Webhook Endpoint
     *
     * KISS:
     * 1. 验证 token
     * 2. 处理 url_verification (Challenge)
     * 3. 处理 card.action.trigger (卡片交互)
     */
    app.post('/lark/webhook', async (c) => {
        const json = await c.req.json().catch(() => ({}))
        const parsed = larkEventSchema.safeParse(json)

        if (!parsed.success) {
            return c.json({ error: 'invalid body' }, 400)
        }

        const data = parsed.data

        const eventType = data.header?.event_type || data.type || 'unknown'
        console.log(`[LarkWebhook] inbound event: ${eventType}`)

        // 1. 安全校验 (Verification Token)
        const token = data.header?.token || (data as any).token
        if (options.verificationToken && token !== options.verificationToken) {
            console.error('[LarkWebhook] Unauthorized: invalid token')
            return c.json({ error: 'unauthorized' }, 401)
        }

        // 2. URL Verification (Challenge)
        if (data.type === 'url_verification' && data.challenge) {
            return c.json({ challenge: data.challenge })
        }

        // 3. Card Action (按钮点击)
        if (data.action?.value) {
            const ctx = data.action.value as PermissionCardContext
            const { sessionId, requestId, action } = ctx

            if (!sessionId || !requestId || !action) {
                return c.json({ code: 1, msg: 'missing context' })
            }

            const engine = options.getSyncEngine()
            if (!engine) return c.json({ code: 1, msg: 'engine not ready' })

            const session = engine.getSession(sessionId)
            if (!session) return c.json({ code: 1, msg: 'session not found' })

            try {
                if (action === 'approve') {
                    await engine.approvePermission(sessionId, requestId)
                } else {
                    await engine.denyPermission(sessionId, requestId)
                }

                // 更新卡片状态 (Patch Message)
                if (data.open_message_id && options.appId && options.appSecret) {
                    const client = new LarkClient({ appId: options.appId, appSecret: options.appSecret })
                    const resultCard = buildPermissionResultCard({
                        sessionName: session.metadata?.name || sessionId,
                        result: action === 'approve' ? 'approved' : 'denied',
                        toolName: (session.agentState?.requests as any)?.[requestId]?.tool
                    })
                    client.patchMessage({
                        openMessageId: data.open_message_id,
                        card: resultCard
                    }).catch(err => console.error('[LarkWebhook] Failed to patch message:', err))
                }

                return c.json({ code: 0, msg: 'success' })
            } catch (err) {
                console.error('[LarkWebhook] Action failed:', err)
                return c.json({ code: 1, msg: String(err) })
            }
        }

        // 4. Message Received (Chat)
        if (eventType === 'im.message.receive_v1' && data.event?.message) {
            const message = data.event.message
            
            // Ignore non-text messages
            if (message.message_type !== 'text') {
                return c.json({ code: 0, msg: 'ignored non-text message' })
            }

            // Parse content
            let text = ''
            try {
                const content = JSON.parse(message.content)
                text = content.text
            } catch {
                return c.json({ code: 0, msg: 'invalid content json' })
            }

            // Ignore empty messages
            if (!text || !text.trim()) {
                return c.json({ code: 0, msg: 'empty message' })
            }

            const engine = options.getSyncEngine()
            if (!engine) return c.json({ code: 0, msg: 'engine not ready' })

            // Routing Strategy:
            // 1. Find all active sessions
            // 2. Pick the most recently active one
            // TODO: Implement better routing (e.g. bind chat_id to session_id)
            const sessions = engine.getActiveSessions()
            if (sessions.length === 0) {
                 // Optionally reply to user via LarkClient (not implemented here to keep webhook fast)
                 console.log('[LarkWebhook] No active session to handle message')
                 return c.json({ code: 0, msg: 'no active session' })
            }
            
            // Sort by activeAt descending (newest first)
            const session = sessions.sort((a, b) => b.activeAt - a.activeAt)[0]
            
            console.log(`[LarkWebhook] Routing message to session ${session.id}: ${text.slice(0, 50)}...`)
            
            await engine.sendMessage(session.id, {
                text,
                sentFrom: 'lark'
            })
            
            return c.json({ code: 0, msg: 'success' })
        }

        return c.json({ code: 0, msg: 'ignored' })
    })

    return app
}
