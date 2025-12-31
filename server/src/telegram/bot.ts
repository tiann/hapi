/**
 * Telegram Bot for HAPI
 *
 * Simplified bot that only handles notifications (permission requests and ready events).
 * All interactive features are handled by the Telegram Mini App.
 */

import { Bot, Context, InlineKeyboard } from 'grammy'
import { SyncEngine, SyncEvent, Session } from '../sync/syncEngine'
import { handleCallback, CallbackContext } from './callbacks'
import { formatSessionNotification, createNotificationKeyboard } from './sessionView'
import type { Store } from '../store'

export interface BotContext extends Context {
    // Extended context for future use
}

export interface HappyBotConfig {
    syncEngine: SyncEngine
    botToken: string
    miniAppUrl: string
    store: Store
}

/**
 * HAPI Telegram Bot - Notification-only mode
 */
export class HappyBot {
    private bot: Bot<BotContext>
    private syncEngine: SyncEngine | null = null
    private isRunning = false
    private readonly miniAppUrl: string
    private readonly store: Store

    // Track last known permission requests per session to detect new ones
    private lastKnownRequests: Map<string, Set<string>> = new Map()

    // Debounce timers for notifications
    private notificationDebounce: Map<string, NodeJS.Timeout> = new Map()

    // Track ready notifications to avoid spam
    private lastReadyNotificationAt: Map<string, number> = new Map()

    // Unsubscribe function for sync events
    private unsubscribeSyncEvents: (() => void) | null = null

    constructor(config: HappyBotConfig) {
        this.syncEngine = config.syncEngine
        this.miniAppUrl = config.miniAppUrl
        this.store = config.store

        this.bot = new Bot<BotContext>(config.botToken)
        this.setupMiddleware()
        this.setupCommands()
        this.setupCallbacks()

        // Subscribe to sync events immediately if engine is available
        if (this.syncEngine) {
            this.setSyncEngine(this.syncEngine)
        }
    }

    /**
     * Update the sync engine reference (after auth)
     */
    setSyncEngine(engine: SyncEngine): void {
        // Unsubscribe from old engine
        if (this.unsubscribeSyncEvents) {
            this.unsubscribeSyncEvents()
            this.unsubscribeSyncEvents = null
        }

        this.syncEngine = engine

        // Subscribe to events for notifications
        this.unsubscribeSyncEvents = engine.subscribe((event) => {
            this.handleSyncEvent(event)
        })
    }

    /**
     * Get the underlying bot instance
     */
    getBot(): Bot<BotContext> {
        return this.bot
    }

    /**
     * Start the bot
     */
    async start(): Promise<void> {
        if (this.isRunning) return

        console.log('[HAPIBot] Starting Telegram bot...')
        this.isRunning = true

        // Start polling
        this.bot.start({
            onStart: (botInfo) => {
                console.log(`[HAPIBot] Bot @${botInfo.username} started`)
            }
        })
    }

    /**
     * Stop the bot
     */
    async stop(): Promise<void> {
        if (!this.isRunning) return

        console.log('[HAPIBot] Stopping Telegram bot...')

        // Unsubscribe from sync events
        if (this.unsubscribeSyncEvents) {
            this.unsubscribeSyncEvents()
            this.unsubscribeSyncEvents = null
        }

        // Clear notification debounce timers
        for (const timer of this.notificationDebounce.values()) {
            clearTimeout(timer)
        }
        this.notificationDebounce.clear()

        await this.bot.stop()
        this.isRunning = false
    }

    /**
     * Setup middleware
     */
    private setupMiddleware(): void {
        // Error handling middleware
        this.bot.catch((err) => {
            console.error('[HAPIBot] Error:', err.message)
        })
    }

    /**
     * Setup command handlers
     */
    private setupCommands(): void {
        // /app - Open Telegram Mini App (primary entry point)
        this.bot.command('app', async (ctx) => {
            const keyboard = new InlineKeyboard().webApp('Open App', this.miniAppUrl)
            await ctx.reply('Open HAPI Mini App:', { reply_markup: keyboard })
        })

        // /start - Simple welcome with Mini App link
        this.bot.command('start', async (ctx) => {
            const keyboard = new InlineKeyboard().webApp('Open App', this.miniAppUrl)
            await ctx.reply(
                'Welcome to HAPI Bot!\n\n' +
                'Use the Mini App for full session management.',
                { reply_markup: keyboard }
            )
        })
    }

    /**
     * Setup callback query handlers for notification buttons
     */
    private setupCallbacks(): void {
        this.bot.on('callback_query:data', async (ctx) => {
            if (!this.syncEngine) {
                await ctx.answerCallbackQuery('Not connected')
                return
            }

            const namespace = this.getNamespaceForChatId(ctx.from?.id ?? null)
            if (!namespace) {
                await ctx.answerCallbackQuery('Telegram account is not bound')
                return
            }

            const data = ctx.callbackQuery.data

            const callbackContext: CallbackContext = {
                syncEngine: this.syncEngine,
                namespace,
                answerCallback: async (text?: string) => {
                    await ctx.answerCallbackQuery(text)
                },
                editMessage: async (text, keyboard) => {
                    await ctx.editMessageText(text, {
                        reply_markup: keyboard
                    })
                }
            }

            await handleCallback(data, callbackContext)
        })
    }

    /**
     * Handle sync engine events for notifications
     */
    private handleSyncEvent(event: SyncEvent): void {
        if (event.type === 'session-updated' && event.sessionId) {
            const session = this.syncEngine?.getSession(event.sessionId)
            if (session) {
                this.checkForPermissionNotification(session)
            }
        }

        if (event.type === 'message-received' && event.sessionId) {
            const message = (event.message?.content ?? event.data) as any
            const messageContent = message?.content
            const eventType = messageContent?.type === 'event' ? messageContent?.data?.type : null

            if (eventType === 'ready') {
                this.sendReadyNotification(event.sessionId).catch((error) => {
                    console.error('[HAPIBot] Failed to send ready notification:', error)
                })
            }
        }
    }

    private getNotifiableSession(sessionId: string): Session | null {
        const session = this.syncEngine?.getSession(sessionId)
        if (!session || !session.active) {
            return null
        }
        return session
    }

    /**
     * Get bound Telegram chat IDs from storage.
     */
    private getBoundChatIds(namespace: string): number[] {
        const users = this.store.getUsersByPlatformAndNamespace('telegram', namespace)
        const ids = new Set<number>()
        for (const user of users) {
            const chatId = Number(user.platformUserId)
            if (Number.isFinite(chatId)) {
                ids.add(chatId)
            }
        }
        return Array.from(ids)
    }

    private getNamespaceForChatId(chatId: number | null | undefined): string | null {
        if (!chatId) {
            return null
        }
        const stored = this.store.getUser('telegram', String(chatId))
        return stored?.namespace ?? null
    }

    /**
     * Send a push notification when agent is ready for input.
     */
    private async sendReadyNotification(sessionId: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        const now = Date.now()
        const last = this.lastReadyNotificationAt.get(sessionId) ?? 0
        if (now - last < 5000) {
            return
        }
        this.lastReadyNotificationAt.set(sessionId, now)

        // Get agent name from flavor
        const flavor = session.metadata?.flavor
        const agentName = flavor === 'claude' ? 'Claude'
                        : flavor === 'codex' ? 'Codex'
                        : flavor === 'gemini' ? 'Gemini'
                        : 'Agent'

        const url = buildMiniAppDeepLink(this.miniAppUrl, `session_${sessionId}`)
        const keyboard = new InlineKeyboard()
            .webApp('Open Session', url)

        const chatIds = this.getBoundChatIds(session.namespace)
        if (chatIds.length === 0) {
            return
        }

        for (const chatId of chatIds) {
            await this.bot.api.sendMessage(
                chatId,
                `It's ready!\n\n${agentName} is waiting for your command`,
                { reply_markup: keyboard }
            )
        }
    }

    /**
     * Check if session has new permission requests and send notification
     */
    private checkForPermissionNotification(session: Session): void {
        const currentSession = this.getNotifiableSession(session.id)
        if (!currentSession) {
            return
        }

        const requests = currentSession.agentState?.requests

        // If requests field is undefined/null, skip - don't clear tracked state on partial updates
        if (requests == null) {
            return
        }

        const newRequestIds = new Set(Object.keys(requests))

        // Get previously known requests for this session
        const oldRequestIds = this.lastKnownRequests.get(session.id) || new Set()

        // Find NEW requests (in new but not in old)
        let hasNewRequests = false
        for (const requestId of newRequestIds) {
            if (!oldRequestIds.has(requestId)) {
                hasNewRequests = true
                break
            }
        }

        // Update tracked state for this session
        this.lastKnownRequests.set(session.id, newRequestIds)

        if (!hasNewRequests) {
            return
        }

        // Debounce notifications per session (500ms)
        const existingTimer = this.notificationDebounce.get(currentSession.id)
        if (existingTimer) {
            clearTimeout(existingTimer)
        }

        const timer = setTimeout(() => {
            this.notificationDebounce.delete(currentSession.id)
            this.sendPermissionNotification(currentSession.id).catch(err => {
                console.error('[HAPIBot] Failed to send notification:', err)
            })
        }, 500)

        this.notificationDebounce.set(currentSession.id, timer)
    }

    /**
     * Send permission notification to all bound chats
     */
    private async sendPermissionNotification(sessionId: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        const text = formatSessionNotification(session)
        const keyboard = createNotificationKeyboard(session, this.miniAppUrl)

        const chatIds = this.getBoundChatIds(session.namespace)
        if (chatIds.length === 0) {
            return
        }

        for (const chatId of chatIds) {
            try {
                await this.bot.api.sendMessage(chatId, text, {
                    reply_markup: keyboard
                })
            } catch (error) {
                console.error(`[HAPIBot] Failed to send notification to chat ${chatId}:`, error)
            }
        }
    }
}

function buildMiniAppDeepLink(baseUrl: string, startParam: string): string {
    try {
        const url = new URL(baseUrl)
        url.searchParams.set('startapp', startParam)
        return url.toString()
    } catch {
        const separator = baseUrl.includes('?') ? '&' : '?'
        return `${baseUrl}${separator}startapp=${encodeURIComponent(startParam)}`
    }
}
