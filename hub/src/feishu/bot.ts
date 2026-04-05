/**
 * Feishu Bot for HAPI - Using Official SDK
 *
 * Uses @larksuiteoapi/node-sdk for WebSocket long connection and API calls.
 *
 * @see https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/preparation-before-development
 */

import * as lark from '@larksuiteoapi/node-sdk'
import type { SyncEngine, Session } from '../sync/syncEngine'
import type { Store } from '../store'
import type { NotificationChannel } from '../notifications/notificationTypes'

// Feishu event types
type ImMessageReceiveV1Data = {
    event_id?: string
    token?: string
    create_time?: string
    event_type?: string
    tenant_key?: string
    ts?: string
    uuid?: string
    type?: string
    app_id?: string
    sender: {
        sender_id?: {
            union_id?: string
            user_id?: string
            open_id?: string
        }
        sender_type: string
        tenant_key?: string
    }
    message: {
        message_id: string
        root_id?: string
        parent_id?: string
        create_time: string
        update_time?: string
        chat_id: string
        thread_id?: string
        chat_type: string
        message_type: string
        content: string
        mentions?: Array<{
            key: string
            id: {
                union_id?: string
                user_id?: string
                open_id?: string
            }
            name: string
            tenant_key?: string
        }>
        user_agent?: string
        sender?: {
            sender_id?: {
                union_id?: string
                user_id?: string
                open_id?: string
            }
            sender_type?: string
            tenant_key?: string
        }
    }
}

type CardActionEventData = {
    open_id: string
    user_id?: string
    tenant_key: string
    open_message_id: string
    token: string
    action: {
        value: Record<string, unknown>
        tag: string
        option?: string
        timezone?: string
    }
}

export interface FeishuBotConfig {
    syncEngine: SyncEngine
    appId: string
    appSecret: string
    baseUrl?: string
    encryptKey?: string | null
    verificationToken?: string | null
    store: Store
}

export class FeishuBot implements NotificationChannel {
    private syncEngine: SyncEngine | null = null
    private store: Store
    private isRunning = false
    private config: FeishuBotConfig

    // SDK clients
    private apiClient: lark.Client | null = null
    private wsClient: lark.WSClient | null = null

    // Pending permission requests for text-based interaction
    private pendingPermissionRequests: Map<string, { sessionId: string; requestId: string; tool: string }> = new Map()

    // Sticky selected session per Feishu user
    private currentSessionByOpenId: Map<string, string> = new Map()

    constructor(config: FeishuBotConfig) {
        this.config = config
        this.store = config.store
        this.syncEngine = config.syncEngine

        // Initialize API client
        const domain = config.baseUrl ? config.baseUrl as unknown as lark.Domain : lark.Domain.Feishu
        this.apiClient = new lark.Client({
            appId: config.appId,
            appSecret: config.appSecret,
            domain,
            appType: lark.AppType.SelfBuild,
            loggerLevel: lark.LoggerLevel.info,
        })
    }

    /**
     * Set/update the sync engine reference
     */
    setSyncEngine(engine: SyncEngine): void {
        this.syncEngine = engine
    }

    /**
     * Start the bot
     */
    async start(): Promise<void> {
        if (this.isRunning || !this.apiClient) {
            return
        }

        console.log('[FeishuBot] Starting...')
        this.isRunning = true

        // Create WebSocket client
        const wsDomain = this.config.baseUrl ? this.config.baseUrl as unknown as lark.Domain : lark.Domain.Feishu
        this.wsClient = new lark.WSClient({
            appId: this.config.appId,
            appSecret: this.config.appSecret,
            domain: wsDomain,
            loggerLevel: lark.LoggerLevel.info,
        })

        // Create event dispatcher
        const eventDispatcher = new lark.EventDispatcher({
            verificationToken: this.config.verificationToken ?? undefined,
            encryptKey: this.config.encryptKey ?? undefined,
        })

        // Register event handlers
        eventDispatcher.register({
            'im.message.receive_v1': async (data: unknown) => {
                await this.handleMessageEvent(data as ImMessageReceiveV1Data)
            },
            'card.action.trigger': async (data: unknown) => {
                return await this.handleCardActionEvent(data as CardActionEventData)
            },
            'im.bot.added_v1': async (data: unknown) => {
                const eventData = data as { event?: { chat_id?: string } }
                console.log('[FeishuBot] Bot added to chat:', eventData.event?.chat_id)
            },
            'im.bot.deleted_v1': async (data: unknown) => {
                const eventData = data as { event?: { chat_id?: string } }
                console.log('[FeishuBot] Bot removed from chat:', eventData.event?.chat_id)
            },
        })

        // Start WebSocket connection
        this.wsClient.start({ eventDispatcher })

        console.log('[FeishuBot] WebSocket connected')
    }

    /**
     * Stop the bot
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            return
        }

        console.log('[FeishuBot] Stopping...')
        this.isRunning = false

        if (this.wsClient) {
            // WSClient doesn't have a stop method in the SDK, just close the connection
            this.wsClient = null
        }
    }

    /**
     * Handle im.message.receive_v1 event
     */
    private async handleMessageEvent(data: ImMessageReceiveV1Data): Promise<void> {
        console.log('[FeishuBot] Received im.message.receive_v1 event:', JSON.stringify(data, null, 2))

        const message = data.message
        if (!message) {
            console.log('[FeishuBot] No message in event')
            return
        }

        // Only handle p2p messages (not group messages)
        if (message.chat_type !== 'p2p') {
            console.log(`[FeishuBot] Ignoring non-p2p message: ${message.chat_type}`)
            return
        }

        // Try multiple locations for sender open_id
        let senderOpenId: string | undefined

        // Location 1: data.sender.sender_id.open_id (event-level sender)
        const anyData = data as unknown as Record<string, unknown>
        const eventSender = anyData.sender as Record<string, unknown> | undefined
        senderOpenId = (eventSender?.sender_id as Record<string, string> | undefined)?.open_id
        console.log(`[FeishuBot] Location 1 (data.sender.sender_id.open_id): ${senderOpenId}`)

        // Location 2: message.sender.sender_id.open_id (SDK typed structure)
        if (!senderOpenId) {
            senderOpenId = message.sender?.sender_id?.open_id
            console.log(`[FeishuBot] Location 2 (message.sender.sender_id.open_id): ${senderOpenId}`)
        }

        // Location 3: data.open_id
        if (!senderOpenId) {
            senderOpenId = anyData.open_id as string | undefined
            console.log(`[FeishuBot] Location 3 (data.open_id): ${senderOpenId}`)
        }

        // Location 4: message.chat_id (fallback)
        if (!senderOpenId) {
            console.log(`[FeishuBot] Using chat_id as fallback: ${message.chat_id}`)
            senderOpenId = message.chat_id
        }

        if (!senderOpenId) {
            console.log('[FeishuBot] No sender open_id found anywhere')
            return
        }
        console.log(`[FeishuBot] Final senderOpenId: ${senderOpenId}`)

        // Parse message content
        let text = ''
        try {
            if (message.content) {
                console.log(`[FeishuBot] Raw message content: ${message.content}`)
                const content = JSON.parse(message.content)
                text = content.text || ''
                console.log(`[FeishuBot] Parsed text: ${text}`)
            } else {
                console.log('[FeishuBot] No message content')
            }
        } catch (e) {
            console.error('[FeishuBot] Failed to parse message content:', e)
            return
        }

        if (!text) {
            console.log('[FeishuBot] Empty text, ignoring')
            return
        }

        // Parse and handle command
        const command = this.parseCommand(text)
        console.log(`[FeishuBot] Parsed command: ${command.command}, args: ${JSON.stringify(command.args)}`)
        await this.handleCommand(senderOpenId, command, message.message_id)
    }

    /**
     * Handle card.action.trigger event
     */
    private async handleCardActionEvent(data: CardActionEventData): Promise<{ toast?: { type: 'success' | 'error'; content: string }; card?: unknown } | void> {
        console.log('[FeishuBot] Received card.action.trigger event:', JSON.stringify(data, null, 2))

        const { action, open_id } = data
        if (!action) {
            console.log('[FeishuBot] No action in card event')
            return { toast: { type: 'error', content: 'No action found' } }
        }

        // Card interaction is not supported, redirect to text commands
        return {
            toast: {
                type: 'error',
                content: 'Please use text commands: /allow <request_id> or /deny <request_id>'
            }
        }
    }

    /**
     * Handle permission approve/deny action
     */
    private async handlePermissionAction(
        openId: string,
        messageId: string,
        value: { action: string; sessionId?: string; requestId?: string }
    ): Promise<void> {
        console.log(`[FeishuBot] handlePermissionAction: openId=${openId}, action=${value.action}, sessionId=${value.sessionId}, requestId=${value.requestId}`)

        if (!this.syncEngine || !this.apiClient) {
            await this.replyToMessage(messageId, 'HAPI is not ready')
            return
        }

        const namespace = this.getNamespaceForOpenId(openId)
        console.log(`[FeishuBot] Namespace for openId: ${namespace}`)
        if (!namespace) {
            await this.replyToMessage(messageId, 'Your Feishu account is not bound. Use /bind <token>')
            return
        }

        const session = value.sessionId ? this.syncEngine.getSession(value.sessionId) : null
        console.log(`[FeishuBot] Session: ${session?.id}, namespace=${session?.namespace}`)
        if (!session || session.namespace !== namespace) {
            await this.replyToMessage(messageId, 'Session not found or access denied')
            return
        }

        if (!value.requestId || !value.sessionId) {
            await this.replyToMessage(messageId, 'No request ID or session ID found')
            return
        }

        const approved = value.action === 'approve'
        console.log(`[FeishuBot] Permission ${approved ? 'approved' : 'denied'} for ${value.requestId}`)

        try {
            if (approved) {
                await this.syncEngine.approvePermission(value.sessionId, value.requestId)
            } else {
                await this.syncEngine.denyPermission(value.sessionId, value.requestId)
            }
            await this.replyToMessage(messageId, approved ? '✅ Permission Approved' : '❌ Permission Denied')
        } catch (error) {
            console.error('[FeishuBot] Failed to handle permission action:', error)
            await this.replyToMessage(messageId, '❌ Failed to process permission action')
        }
    }

    /**
     * Parse command from message text
     */
    private parseCommand(text: string): { command: string; args: string[]; raw: string } {
        const trimmed = text.trim()
        const parts = trimmed.split(/\s+/)
        const command = parts[0].toLowerCase().replace(/^\//, '')
        const args = parts.slice(1)
        return { command, args, raw: trimmed }
    }

    /**
     * Handle user command
     */
    private async handleCommand(
        openId: string,
        command: { command: string; args: string[]; raw: string },
        messageId: string
    ): Promise<void> {
        switch (command.command) {
            case 'bind':
                await this.handleBind(openId, command.args, messageId)
                break
            case 'sessions':
            case 'list':
                await this.handleListSessions(openId)
                break
            case 'send':
                await this.handleSend(openId, command.args, messageId)
                break
            case 'allow':
            case 'approve':
                await this.handleAllowDeny(openId, command.args, messageId, true)
                break
            case 'deny':
            case 'reject':
                await this.handleAllowDeny(openId, command.args, messageId, false)
                break
            case 'cmds':
            case 'commands':
                await this.handleListCommands(openId, messageId)
                break
            case 'help':
            case 'start':
                await this.handleHelp(openId)
                break
            default:
                // Preserve raw text (including leading /) when passing to Claude
                await this.handleDirectMessage(openId, command.raw, messageId)
        }
    }

    /**
     * Handle /bind command
     */
    private async handleBind(openId: string, args: string[], messageId: string): Promise<void> {
        console.log(`[FeishuBot] handleBind called: openId=${openId}, args=${JSON.stringify(args)}, messageId=${messageId}`)

        if (args.length === 0) {
            console.log('[FeishuBot] No args provided, sending usage message')
            await this.replyToMessage(messageId, 'Usage: /bind <token>')
            return
        }

        const token = args[0]
        const namespace = token.includes(':') ? token.split(':')[1] : 'default'

        // Remove ALL existing feishu users for this namespace to avoid cross-app open_id issues
        console.log(`[FeishuBot] Removing all existing feishu users for namespace ${namespace}`)
        const existingUsers = this.store.users.getUsersByPlatformAndNamespace('feishu', namespace)
        console.log(`[FeishuBot] Found ${existingUsers.length} existing users:`, existingUsers)
        for (const user of existingUsers) {
            console.log(`[FeishuBot] Removing old user: ${user.platformUserId}`)
            this.store.users.removeUser('feishu', user.platformUserId)
        }

        console.log(`[FeishuBot] Adding user: platform=feishu, openId=${openId}, namespace=${namespace}`)
        const newUser = this.store.users.addUser('feishu', openId, namespace)
        console.log(`[FeishuBot] New user added:`, newUser)

        // Verify
        const verifyUsers = this.store.users.getUsersByPlatformAndNamespace('feishu', namespace)
        console.log(`[FeishuBot] After bind, users in namespace:`, verifyUsers)

        console.log(`[FeishuBot] User added, sending reply...`)
        await this.replyToMessage(messageId, `✅ Bound to namespace: ${namespace}`)
        console.log(`[FeishuBot] Bind complete`)
    }

    /**
     * Handle /sessions command
     */
    private async handleListSessions(openId: string): Promise<void> {
        const namespace = this.getNamespaceForOpenId(openId)
        if (!namespace) {
            await this.sendTextMessage(openId, 'Not bound. Use /bind <token> first.')
            return
        }

        if (!this.syncEngine) {
            await this.sendTextMessage(openId, 'HAPI is not ready')
            return
        }

        const sessions = this.syncEngine.getSessionsByNamespace(namespace)
        const activeSessions = sessions.filter((s: Session) => s.active)

        if (activeSessions.length === 0) {
            await this.sendTextMessage(openId, 'No active sessions.')
            return
        }

        let text = '📋 **Active Sessions**\n\n'
        for (const session of activeSessions) {
            const sessionName = session.metadata?.name || session.id.slice(0, 8)
            const agentName = session.metadata?.flavor || 'Agent'
            const sessionPath = session.metadata?.path || '-'
            const sessionSummary = session.metadata?.summary?.text || '-'
            text += `• **${sessionName}** (${agentName})\n  ID: ${session.id}\n  Path: ${sessionPath}\n  Recent: ${sessionSummary}\n\n`
        }

        await this.sendTextMessage(openId, text)
    }

    /**
     * Handle /send command
     */
    private async handleSend(openId: string, args: string[], messageId: string): Promise<void> {
        if (args.length < 2) {
            await this.replyToMessage(messageId, 'Usage: /send <session_id> <message>')
            return
        }

        const sessionId = args[0]
        const messageText = args.slice(1).join(' ')

        await this.sendMessageToSession(openId, sessionId, messageText, messageId)
    }

    /**
     * Find session by full id or prefix within namespace
     */
    private findSessionForNamespace(namespace: string, sessionIdOrPrefix: string): Session | null {
        if (!this.syncEngine) {
            return null
        }

        const sessions = this.syncEngine.getSessionsByNamespace(namespace)
        const exact = sessions.find((s: Session) => s.id === sessionIdOrPrefix)
        if (exact) {
            return exact
        }

        const matched = sessions.filter((s: Session) => s.id.startsWith(sessionIdOrPrefix))
        if (matched.length === 1) {
            return matched[0] ?? null
        }

        return null
    }

    /**
     * Handle direct message (not a command)
     */
    private async handleDirectMessage(openId: string, text: string, messageId: string): Promise<void> {
        console.log(`[FeishuBot] handleDirectMessage: openId=${openId}, text=${text.substring(0, 50)}`)

        const namespace = this.getNamespaceForOpenId(openId)
        if (!namespace) {
            console.log(`[FeishuBot] No namespace found for openId=${openId}`)
            await this.replyToMessage(messageId, 'Not bound. Use /bind <token> first.')
            return
        }
        console.log(`[FeishuBot] Found namespace: ${namespace}`)

        if (!this.syncEngine) {
            await this.replyToMessage(messageId, 'HAPI is not ready')
            return
        }

        const sessions = this.syncEngine.getSessionsByNamespace(namespace)
        console.log(`[FeishuBot] Found ${sessions.length} sessions in namespace ${namespace}`)

        const activeSessions = sessions.filter((s: Session) => s.active)
        console.log(`[FeishuBot] Found ${activeSessions.length} active sessions`)

        if (activeSessions.length === 0) {
            await this.replyToMessage(messageId, 'No active sessions. Start a session in HAPI first.')
            return
        }

        const currentSessionId = this.currentSessionByOpenId.get(openId)
        if (currentSessionId) {
            const currentSession = activeSessions.find((s: Session) => s.id === currentSessionId)
            if (currentSession) {
                console.log(`[FeishuBot] Reusing sticky session: ${currentSession.id}`)
                await this.sendMessageToSession(openId, currentSession.id, text.trim(), messageId)
                return
            }
        }

        if (activeSessions.length === 1) {
            const session = activeSessions[0]
            this.currentSessionByOpenId.set(openId, session.id)
            console.log(`[FeishuBot] Auto-selecting only active session: ${session.id}`)
            await this.sendMessageToSession(openId, session.id, text.trim(), messageId)
            return
        }

        await this.replyToMessage(messageId, 'Multiple active sessions found. Use /sessions to view them, then /send <session_id> <message> once to choose a session. After that, later messages will continue using that same session automatically.')
    }

    /**
     * Send message to a session
     */
    private async sendMessageToSession(
        openId: string,
        sessionId: string,
        text: string,
        replyToMessageId: string
    ): Promise<void> {
        if (!this.syncEngine) {
            await this.replyToMessage(replyToMessageId, 'HAPI is not ready')
            return
        }

        const namespace = this.getNamespaceForOpenId(openId)
        if (!namespace) {
            await this.replyToMessage(replyToMessageId, 'Not bound')
            return
        }

        const session = this.findSessionForNamespace(namespace, sessionId)
        if (!session) {
            await this.replyToMessage(replyToMessageId, 'Session not found or access denied')
            return
        }

        if (!session.active) {
            await this.replyToMessage(replyToMessageId, 'Session is not active')
            return
        }

        try {
            // Remember selected session for subsequent direct messages
            this.currentSessionByOpenId.set(openId, session.id)

            // Send message via syncEngine to CLI
            await this.syncEngine.sendMessage(session.id, {
                text,
                sentFrom: 'feishu'  // Use feishu type for external messages
            })
            console.log(`[FeishuBot] Message sent to session ${session.id}: ${text}`)
            await this.replyToMessage(replyToMessageId, `✅ Message sent to session\nPath: ${session.metadata?.path || '-'}`)
        } catch (error) {
            console.error(`[FeishuBot] Failed to send message to session ${sessionId}:`, error)
            await this.replyToMessage(replyToMessageId, '❌ Failed to send message')
        }
    }

    /**
     * Handle /help command
     */
    private async handleHelp(openId: string): Promise<void> {
        const text = `❓ **HAPI Bot Help**

**Available Commands:**

• **/bind <token>** - Bind your Feishu account to a namespace
• **/sessions** - List all active sessions
• **/cmds** - List slash commands for the current active session
• **/send <session_id> <message>** - Send a message to an agent and set it as the current session
• **/allow <request_id>** - Approve a permission request
• **/deny <request_id>** - Deny a permission request
• **/help** - Show this help message
• **Direct message** - Reuse the previously selected session automatically

**Special pass-through commands:**
• **/compact** - Pass through to Claude
• **/clear** - Pass through to Claude`
        await this.sendTextMessage(openId, text)
    }

    /**
     * Handle /cmds command
     */
    private async handleListCommands(openId: string, messageId: string): Promise<void> {
        const namespace = this.getNamespaceForOpenId(openId)
        if (!namespace) {
            await this.replyToMessage(messageId, 'Not bound. Use /bind <token> first.')
            return
        }

        if (!this.syncEngine) {
            await this.replyToMessage(messageId, 'HAPI is not ready')
            return
        }

        const sessions = this.syncEngine.getSessionsByNamespace(namespace)
        const activeSessions = sessions.filter((s: Session) => s.active)
        if (activeSessions.length === 0) {
            await this.replyToMessage(messageId, 'No active sessions. Start a session in HAPI first.')
            return
        }

        const session = activeSessions.sort(
            (a: Session, b: Session) => (b.updatedAt || 0) - (a.updatedAt || 0)
        )[0]

        try {
            const agent = session.metadata?.flavor ?? 'claude'
            const result = await this.syncEngine.listSlashCommands(session.id, agent)
            if (!result.success || !result.commands || result.commands.length === 0) {
                await this.replyToMessage(messageId, 'No slash commands found for the current session.')
                return
            }

            const commandLines = result.commands
                .map((cmd) => `• /${cmd.name}${cmd.description ? ` — ${cmd.description}` : ''}`)
                .join('\n')

            const text = `⚡ **Slash Commands**\n\nSession: ${session.metadata?.name || session.id.slice(0, 8)}\nPath: ${session.metadata?.path || '-'}\n\n${commandLines}`
            await this.replyToMessage(messageId, text)
        } catch (error) {
            console.error('[FeishuBot] Failed to list slash commands:', error)
            await this.replyToMessage(messageId, 'Failed to list slash commands')
        }
    }

    /**
     * Handle /allow and /deny commands
     */
    private async handleAllowDeny(
        openId: string,
        args: string[],
        messageId: string,
        allow: boolean
    ): Promise<void> {
        if (args.length === 0) {
            await this.replyToMessage(messageId, `Usage: /${allow ? 'allow' : 'deny'} <request_id>`)
            return
        }

        const requestIdShort = args[0]
        const namespace = this.getNamespaceForOpenId(openId)

        if (!namespace) {
            await this.replyToMessage(messageId, 'Not bound. Use /bind <token> first.')
            return
        }

        if (!this.syncEngine) {
            await this.replyToMessage(messageId, 'HAPI is not ready')
            return
        }

        // Find the full request ID from the short form
        let fullRequestId: string | null = null
        let sessionId: string | null = null

        for (const [key, value] of this.pendingPermissionRequests.entries()) {
            if (key.startsWith(requestIdShort) || key.slice(0, 8) === requestIdShort) {
                fullRequestId = key
                sessionId = value.sessionId
                break
            }
        }

        if (!fullRequestId || !sessionId) {
            await this.replyToMessage(messageId, 'Request not found or expired. Please check the request ID.')
            return
        }

        const session = this.syncEngine.getSession(sessionId)
        if (!session || session.namespace !== namespace) {
            await this.replyToMessage(messageId, 'Session not found or access denied')
            return
        }

        try {
            if (allow) {
                await this.syncEngine.approvePermission(sessionId, fullRequestId)
            } else {
                await this.syncEngine.denyPermission(sessionId, fullRequestId)
            }

            // Remove from pending requests
            this.pendingPermissionRequests.delete(fullRequestId)

            await this.replyToMessage(messageId, allow ? '✅ Permission Approved' : '❌ Permission Denied')
        } catch (error) {
            console.error('[FeishuBot] Failed to handle permission:', error)
            await this.replyToMessage(messageId, '❌ Failed to process permission action')
        }
    }

    /**
     * Get namespace for Feishu open_id
     */
    private getNamespaceForOpenId(openId: string): string | null {
        console.log(`[FeishuBot] getNamespaceForOpenId: openId=${openId}`)
        const stored = this.store.users.getUser('feishu', openId)
        console.log(`[FeishuBot] getUser result:`, stored)
        return stored?.namespace ?? null
    }

    /**
     * Get bound Feishu open_ids for a namespace
     */
    private getBoundOpenIds(namespace: string): string[] {
        const users = this.store.users.getUsersByPlatformAndNamespace('feishu', namespace)
        console.log(`[FeishuBot] getBoundOpenIds for namespace ${namespace}:`, users.map(u => ({ id: u.id, platformUserId: u.platformUserId, namespace: u.namespace })))
        return users.map((u) => u.platformUserId)
    }

    /**
     * Send text message using SDK
     */
    private async sendTextMessage(openId: string, text: string): Promise<void> {
        if (!this.apiClient) return

        try {
            await this.apiClient.im.message.create({
                params: {
                    receive_id_type: 'open_id',
                },
                data: {
                    receive_id: openId,
                    content: JSON.stringify({ text }),
                    msg_type: 'text',
                },
            })
        } catch (error) {
            console.error('[FeishuBot] Failed to send text message:', error)
        }
    }

    /**
     * Send card message using SDK
     */
    private async sendCardMessage(openId: string, card: unknown): Promise<void> {
        if (!this.apiClient) return

        try {
            await this.apiClient.im.message.create({
                params: {
                    receive_id_type: 'open_id',
                },
                data: {
                    receive_id: openId,
                    content: JSON.stringify(card),
                    msg_type: 'interactive',
                },
            })
        } catch (error) {
            console.error('[FeishuBot] Failed to send card message:', error)
        }
    }

    /**
     * Reply to a message using SDK
     */
    private async replyToMessage(messageId: string, text: string): Promise<void> {
        if (!this.apiClient) return

        try {
            await this.apiClient.im.message.reply({
                path: {
                    message_id: messageId,
                },
                data: {
                    content: JSON.stringify({ text }),
                    msg_type: 'text',
                },
            })
        } catch (error) {
            console.error('[FeishuBot] Failed to reply to message:', error)
        }
    }

    //
    // NotificationChannel implementation
    //

    /**
     * Send "ready" notification
     */
    async sendReady(session: Session): Promise<void> {
        if (!session.active || !this.apiClient) {
            return
        }

        const openIds = this.getBoundOpenIds(session.namespace)
        if (openIds.length === 0) {
            return
        }

        const sessionName = session.metadata?.name || session.id.slice(0, 8)
        const agentName = session.metadata?.flavor || 'Agent'
        const sessionPath = session.metadata?.path || '-'
        const text = `✅ **${agentName}** is ready\n\nSession: ${sessionName}\nPath: ${sessionPath}\n\nThe agent is waiting for your next command.`

        for (const openId of openIds) {
            try {
                await this.sendTextMessage(openId, text)
            } catch (error) {
                console.error(`[FeishuBot] Failed to send ready notification to ${openId}:`, error)
            }
        }
    }

    /**
     * Send permission request notification
     */
    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active || !this.apiClient) {
            return
        }

        const openIds = this.getBoundOpenIds(session.namespace)
        if (openIds.length === 0) {
            return
        }

        const requests = session.agentState?.requests
        if (!requests) {
            return
        }

        const requestIds = Object.keys(requests)
        if (requestIds.length === 0) {
            return
        }

        const requestId = requestIds[0]
        const request = requests[requestId]
        if (!request) {
            return
        }

        const sessionName = session.metadata?.name || session.id.slice(0, 8)
        const agentName = session.metadata?.flavor || 'Agent'
        const sessionPath = session.metadata?.path || '-'
        const tool = request.tool || 'unknown'
        const args = request.arguments || {}

        // Format tool info
        let toolInfo = `**Tool:** ${tool}`
        if (args && typeof args === 'object') {
            const argsObj = args as Record<string, unknown>
            if (argsObj.file_path || argsObj.path) {
                toolInfo += `\n**File:** ${String(argsObj.file_path || argsObj.path)}`
            }
            if (argsObj.command) {
                toolInfo += `\n**Command:** ${String(argsObj.command).slice(0, 100)}`
            }
            if (argsObj.url) {
                toolInfo += `\n**URL:** ${String(argsObj.url)}`
            }
        }

        // Store pending request for text-based interaction
        this.pendingPermissionRequests.set(requestId, {
            sessionId: session.id,
            requestId,
            tool
        })

        // Clean up old requests (keep only last 20)
        const keys = Array.from(this.pendingPermissionRequests.keys())
        if (keys.length > 20) {
            for (const key of keys.slice(0, keys.length - 20)) {
                this.pendingPermissionRequests.delete(key)
            }
        }

        const text = `🔔 **Permission Request - ${agentName}**\n\nSession: ${sessionName}\nPath: ${sessionPath}\n\n${toolInfo}\n\nTo approve, reply: /allow ${requestId.slice(0, 8)}\nTo deny, reply: /deny ${requestId.slice(0, 8)}`

        for (const openId of openIds) {
            try {
                await this.sendTextMessage(openId, text)
            } catch (error) {
                console.error(`[FeishuBot] Failed to send permission request to ${openId}:`, error)
            }
        }
    }

    /**
     * Send assistant message notification
     */
    async sendMessage(session: Session, text: string): Promise<void> {
        console.log(`[FeishuBot] sendMessage: session=${session.id}, text=${text.substring(0, 50)}`)

        if (!session.active || !this.apiClient) {
            console.log(`[FeishuBot] Session not active or apiClient not ready`)
            return
        }

        const openIds = this.getBoundOpenIds(session.namespace)
        console.log(`[FeishuBot] Found ${openIds.length} bound openIds in namespace ${session.namespace}`)

        if (openIds.length === 0) {
            return
        }

        // Truncate long messages
        const maxLength = 2000
        const displayText = text.length > maxLength ? text.slice(0, maxLength) + '...' : text

        const agentName = session.metadata?.flavor ? session.metadata.flavor.charAt(0).toUpperCase() + session.metadata.flavor.slice(1) : 'Agent'
        const sessionPath = session.metadata?.path || '-'

        for (const openId of openIds) {
            try {
                console.log(`[FeishuBot] Sending message to openId=${openId}`)
                await this.sendTextMessage(openId, `🤖 **${agentName}**\nPath: ${sessionPath}\n\n${displayText}`)
            } catch (error) {
                console.error(`[FeishuBot] Failed to send message to ${openId}:`, error)
            }
        }
    }
}
