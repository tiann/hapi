import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import { LarkClient } from '../../lark/larkClient'
import { buildPermissionResultCard, type PermissionCardContext } from '../../lark/larkCardBuilder'
import type { SyncEngine } from '../../sync/syncEngine'
import type { LarkWipNotifier } from '../../lark/larkWipNotifier'

const larkEventSchema = z.object({
    header: z.object({
        event_type: z.string().optional(),
        token: z.string().optional()
    }).passthrough().optional(),
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
    type: z.string().optional(), // url_verification
    token: z.string().optional() // 兼容顶层 token 字段
}).passthrough()

export function createLarkWebhookRoutes(options: {
    getSyncEngine: () => SyncEngine | null
    getLarkNotifier?: () => LarkWipNotifier | null
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
            const chatId = message.chat_id
            
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

            text = text.trim()

            const engine = options.getSyncEngine()
            if (!engine) return c.json({ code: 0, msg: 'engine not ready' })

            const notifier = options.getLarkNotifier?.()

            const userId = data.event?.sender?.sender_id?.open_id || 'unknown'
            const messageId = message.message_id

            if (text.startsWith('/') || text.startsWith('!') || text.startsWith('@')) {
                if (notifier) {
                    notifier.handleSlashCommand(chatId, text, userId, messageId).catch(err => {
                        console.error('[LarkWebhook] Slash command failed:', err)
                    })
                    return c.json({ code: 0, msg: 'command received' })
                }
                return c.json({ code: 0, msg: 'notifier not available' })
            }

            // Routing Strategy:
            // 1. Check if this chat has a bound session
            // 2. Otherwise, find the most recently active session
            let sessionId = notifier?.getSessionForChat(chatId)
            
            if (!sessionId) {
                const sessions = engine.getActiveSessions()
                if (sessions.length === 0) {
                    // No active session - send helpful message
                    if (notifier) {
                        notifier.sendTextToChat(chatId, 
                            '❌ 当前没有活跃的 Session。\n\n' +
                            '请先在终端运行 `hapi start` 启动一个 Session，然后使用 `/sessions` 查看可用会话。'
                        ).catch(console.error)
                    }
                    console.log('[LarkWebhook] No active session to handle message')
                    return c.json({ code: 0, msg: 'no active session' })
                }
                
                // Pick the most recently active session
                const session = sessions.sort((a, b) => b.activeAt - a.activeAt)[0]
                sessionId = session.id
                
                // Bind this chat to the session
                if (notifier) {
                    notifier.setSessionForChat(chatId, sessionId)
                    console.log(`[LarkWebhook] Bound chat ${chatId} to session ${sessionId}`)
                }
            }
            
            const session = engine.getSession(sessionId)
            if (!session) {
                // Session no longer exists, clear binding
                if (notifier) {
                    notifier.sendTextToChat(chatId,
                        '❌ 绑定的 Session 已不存在。\n\n' +
                        '使用 `/sessions` 查看可用会话，或使用 `/switch <id>` 切换到其他会话。'
                    ).catch(console.error)
                }
                return c.json({ code: 0, msg: 'session not found' })
            }

            console.log(`[LarkWebhook] Routing message to session ${sessionId}: ${text.slice(0, 50)}...`)
            
            // Send thinking indicator
            if (notifier) {
                const sessionName = session.metadata?.name || session.metadata?.path?.split('/').pop() || sessionId
                notifier.sendThinkingIndicator(chatId, sessionName).catch(console.error)
            }
            
            await engine.sendMessage(sessionId, {
                text,
                sentFrom: 'lark'
            })
            
            return c.json({ code: 0, msg: 'success' })
        }

        return c.json({ code: 0, msg: 'ignored' })
    })

    return app
}
