/**
 * Telegram Bot for Happy
 *
 * Main bot class that initializes grammy, applies middleware,
 * and sets up command handlers.
 */

import { Bot, Context, NextFunction, InlineKeyboard } from 'grammy'
import { configuration } from '../configuration'
import { SyncEngine, SyncEvent, Session } from '../sync/syncEngine'
import { getSessionName, truncate } from './renderer'
import {
    handleCallback,
    CallbackContext,
} from './callbacks'
import {
    formatSessionNotification,
    createNotificationKeyboard
} from './sessionView'

export interface BotContext extends Context {
    // Extended context for future use (session state, etc.)
}

export interface HappyBotConfig {
    syncEngine: SyncEngine
}

/**
 * Happy Telegram Bot
 */
export class HappyBot {
    private bot: Bot<BotContext>
    private syncEngine: SyncEngine | null = null
    private isRunning = false

    // Track last known permission requests per session to detect new ones
    private lastKnownRequests: Map<string, Set<string>> = new Map() // sessionId -> requestIds

    // Debounce timers for notifications
    private notificationDebounce: Map<string, NodeJS.Timeout> = new Map() // sessionId -> timer

    // Track ready notifications to avoid spam
    private lastReadyNotificationAt: Map<string, number> = new Map() // sessionId -> timestamp

    // Unsubscribe function for sync events
    private unsubscribeSyncEvents: (() => void) | null = null

    constructor(config: HappyBotConfig) {
        this.syncEngine = config.syncEngine

        this.bot = new Bot<BotContext>(configuration.telegramBotToken)
        this.setupMiddleware()
        this.setupCommands()
        this.setupCallbacks()
        this.setupMessageHandler()

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

        console.log('[HappyBot] Starting Telegram bot...')
        this.isRunning = true

        // Start polling
        this.bot.start({
            onStart: (botInfo) => {
                console.log(`[HappyBot] Bot @${botInfo.username} started`)
            }
        })
    }

    /**
     * Stop the bot
     */
    async stop(): Promise<void> {
        if (!this.isRunning) return

        console.log('[HappyBot] Stopping Telegram bot...')

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
        // Security middleware: only allow configured chat IDs
        this.bot.use(async (ctx: BotContext, next: NextFunction) => {
            const chatId = ctx.chat?.id
            if (!chatId || !configuration.allowedChatIds.includes(chatId)) {
                console.log(`[HappyBot] Rejected message from unauthorized chat: ${chatId}`)
                return // Silently ignore unauthorized users
            }
            await next()
        })

        // Error handling middleware
        this.bot.catch((err) => {
            console.error('[HappyBot] Error:', err.message)
        })
    }

    /**
     * Setup command handlers
     */
    private setupCommands(): void {
        // /start - Status + help
        this.bot.command('start', async (ctx) => {
            const sessionCount = this.syncEngine?.getActiveSessions().length ?? 0
            const machineCount = this.syncEngine?.getOnlineMachines().length ?? 0

            await ctx.reply(
                `Welcome to Happy Bot!\n\n` +
                `Active Sessions: ${sessionCount}\n` +
                `Online Machines: ${machineCount}\n\n` +
                `Commands:\n` +
                `/app - Open the Mini App\n` +
                `/help - Show help\n`
            )
        })

        // /help - Show help information
        this.bot.command('help', async (ctx) => {
            await ctx.reply(
                `Happy Bot Help\n\n` +
                `Happy Bot is a notification layer for Happy sessions.\n\n` +
                `Commands:\n` +
                `/start - Start the bot or show status\n` +
                `/app - Open the Mini App\n` +
                `/help - Show this help message\n\n` +
                `Use the Mini App for:\n` +
                `- Session list and full chat UI\n` +
                `- Approving/denying permissions\n` +
                `- Aborting sessions and changing modes/models\n` +
                `- Viewing machines and creating new sessions`
            )
        })

        // /app - Open Telegram Mini App
        this.bot.command('app', async (ctx) => {
            const keyboard = new InlineKeyboard().webApp('📱 Open App', configuration.miniAppUrl)
            await ctx.reply('Open Happy Mini App:', { reply_markup: keyboard })
        })

    }

    /**
     * Setup callback query handlers (InlineKeyboard buttons)
     */
    private setupCallbacks(): void {
        this.bot.on('callback_query:data', async (ctx) => {
            if (!this.syncEngine) {
                await ctx.answerCallbackQuery('Not connected')
                return
            }

            const data = ctx.callbackQuery.data

            // Handle other callbacks
            const callbackContext: CallbackContext = {
                syncEngine: this.syncEngine,
                answerCallback: async (text?: string) => {
                    await ctx.answerCallbackQuery(text)
                },
                editMessage: async (text, keyboard) => {
                    await ctx.editMessageText(text, {
                        reply_markup: keyboard
                    })
                },
                sendMessage: async (text, keyboard) => {
                    await ctx.reply(text, {
                        reply_markup: keyboard
                    })
                }
            }

            await handleCallback(data, callbackContext)
        })
    }

    /**
     * Setup text message handler for sending messages to Claude
     */
    private setupMessageHandler(): void {
        // Handle text messages (non-commands)
        this.bot.on('message:text', async (ctx) => {
            // Skip if it's a command
            if (ctx.message.text.startsWith('/')) return

            if (!this.syncEngine) {
                await ctx.reply('Not ready yet. Try again in a moment.')
                return
            }

            const keyboard = new InlineKeyboard().webApp('📱 Open App', configuration.miniAppUrl)
            await ctx.reply(
                'Chat and session controls are available in the Mini App.',
                { reply_markup: keyboard }
            )
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
            const message = event.data as any
            const messageContent = message?.content
            const eventType = messageContent?.type === 'event' ? messageContent?.data?.type : null

            if (eventType === 'ready') {
                this.sendReadyNotification(event.sessionId).catch((error) => {
                    console.error('[HappyBot] Failed to send ready notification:', error)
                })
                return
            }

            if (eventType === 'switch') {
                const mode = messageContent?.data?.mode === 'local' ? 'local' : 'remote'
                this.sendSwitchNotification(event.sessionId, mode).catch((error) => {
                    console.error('[HappyBot] Failed to send switch notification:', error)
                })
                return
            }

            const role = typeof message?.role === 'string' ? message.role : null
            if (role !== 'assistant' && role !== 'agent') {
                return
            }

            const preview = this.extractMessagePreview(message)
            if (!preview) {
                return
            }

            this.sendMessageNotification(event.sessionId, preview).catch((error) => {
                console.error('[HappyBot] Failed to send message notification:', error)
            })
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
     * Send a push notification when Claude is ready for input.
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

        const name = getSessionName(session)

        const url = buildMiniAppDeepLink(configuration.miniAppUrl, `session_${sessionId}`)
        const keyboard = new InlineKeyboard()
            .webApp('📱 Open Session', url)

        for (const chatId of configuration.allowedChatIds) {
            await this.bot.api.sendMessage(
                chatId,
                `✅ ${name} is ready\n\nClaude is waiting for your next message.`,
                { reply_markup: keyboard }
            )
        }
    }

    private async sendSwitchNotification(sessionId: string, mode: 'local' | 'remote'): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }
        const name = getSessionName(session)

        const url = buildMiniAppDeepLink(configuration.miniAppUrl, `session_${sessionId}`)
        const keyboard = new InlineKeyboard()
            .webApp('📱 Details', url)

        for (const chatId of configuration.allowedChatIds) {
            await this.bot.api.sendMessage(
                chatId,
                `🔄 ${name} switched to ${mode}`,
                { reply_markup: keyboard }
            )
        }
    }

    private async sendMessageNotification(sessionId: string, previewText: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }
        const name = getSessionName(session)

        const url = buildMiniAppDeepLink(configuration.miniAppUrl, `session_${sessionId}`)
        const keyboard = new InlineKeyboard()
            .webApp('📱 Open Session', url)

        const body = truncate(previewText, 600)

        for (const chatId of configuration.allowedChatIds) {
            await this.bot.api.sendMessage(
                chatId,
                `💬 ${name}\n\n${body}`,
                { reply_markup: keyboard }
            )
        }
    }

    private extractMessagePreview(message: any): string | null {
        const messageContent = message?.content

        if (typeof messageContent === 'string') {
            return messageContent.trim() || null
        }

        if (!messageContent || typeof messageContent !== 'object') {
            return null
        }

        if (messageContent.type === 'text' && typeof messageContent.text === 'string') {
            return messageContent.text.trim() || null
        }

        if (Array.isArray(messageContent)) {
            const textBlocks = messageContent
                .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
                .map((block: any) => block.text)
                .filter((text: string) => text.trim().length > 0)

            if (textBlocks.length > 0) {
                return textBlocks.join('\n')
            }
        }

        return null
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
                console.error('[HappyBot] Failed to send notification:', err)
            })
        }, 500)

        this.notificationDebounce.set(currentSession.id, timer)
    }

    /**
     * Send permission notification to all allowed chats
     */
    private async sendPermissionNotification(sessionId: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        const text = formatSessionNotification(session, 'permission')
        const keyboard = createNotificationKeyboard(session)

        // Send to all allowed chat IDs
        for (const chatId of configuration.allowedChatIds) {
            try {
                await this.bot.api.sendMessage(chatId, text, {
                    reply_markup: keyboard
                })
            } catch (error) {
                console.error(`[HappyBot] Failed to send notification to chat ${chatId}:`, error)
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
