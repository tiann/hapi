import * as Lark from '@larksuiteoapi/node-sdk'
import { LRUCache } from 'lru-cache'
import type { SyncEngine, SyncEvent } from '../sync/syncEngine'
import { LarkClient } from './larkClient'
import { commandRouter, initializeCommands, type CommandContext, type AgentType } from '../commands'
import { ResponseAccumulatorManager } from './responseAccumulator'
import { buildSessionInfoCard } from '../commands/cards/sessionCards'
import { LarkCardBuilder, type InteractiveCard } from './cardBuilder'
import { setNotifyState } from '../commands/hapi/notify'
import { buildNotifyCard, buildSettingsCard, type SettingsTab } from '../commands/cards/interactionCards'
import { buildStatsCard, type StatsTab } from '../commands/cards/statsCards'
import type { AgentMessage, AgentOutputMessage } from '../types/agentProtocol'

interface LarkCardActionEvent {
    operator: {
        open_id: string
        user_id: string
    }
    token: string
    action: {
        value: any
        tag: string
        name?: string
        form_value?: Record<string, any>
    }
    context: {
        open_message_id: string
        open_chat_id: string
    }
}

export interface LarkWSClientConfig {
    appId: string
    appSecret: string
    getSyncEngine: () => SyncEngine | null
    domain?: string
    logLevel?: 'info' | 'debug' | 'warn' | 'error'
}

export interface LarkMessageEvent {
    event_id?: string
    token?: string
    create_time?: string
    event_type?: string
    tenant_key?: string
    ts?: string
    uuid?: string
    type?: string
    app_id?: string
    message: {
        message_id: string
        chat_id: string
        chat_type: string
        message_type: string
        content: string
        root_id?: string
        parent_id?: string
        create_time?: string
        update_time?: string
        mentions?: unknown[]
    }
    sender: {
        sender_id?: {
            open_id?: string
            user_id?: string
            union_id?: string
        }
        sender_type?: string
        tenant_key?: string
    }
}

export class LarkWebSocketClient {
    private wsClient: any
    private larkClient: LarkClient
    private eventCache: LRUCache<string, boolean>
    private p2pChats: Map<string, string>
    private p2pUsers: Map<string, string>
    private chatSessions: Map<string, string>
    private sessionChats: Map<string, string>
    private accumulatorManager: ResponseAccumulatorManager
    private config: LarkWSClientConfig
    private started = false
    private unsubscribe: (() => void) | null = null

    constructor(config: LarkWSClientConfig) {
        this.config = config

        this.eventCache = new LRUCache<string, boolean>({
            max: 1000,
            ttl: 3600000
        })

        this.p2pChats = new Map()
        this.p2pUsers = new Map()
        this.chatSessions = new Map()
        this.sessionChats = new Map()

        const logLevel = this.getLogLevel(config.logLevel || 'info')

        this.wsClient = new Lark.WSClient({
            appId: config.appId,
            appSecret: config.appSecret,
            domain: config.domain || 'https://open.feishu.cn',
            loggerLevel: logLevel
        })

        this.larkClient = new LarkClient({
            appId: config.appId,
            appSecret: config.appSecret,
            baseUrl: (config.domain || 'https://open.feishu.cn') + '/open-apis'
        })

        this.accumulatorManager = new ResponseAccumulatorManager(this.larkClient)

        initializeCommands()
        console.log('[LarkWS] WebSocket client initialized')
    }

    private getLogLevel(level: string): any {
        const levels: Record<string, any> = {
            'info': Lark.LoggerLevel.info,
            'debug': Lark.LoggerLevel.debug,
            'warn': Lark.LoggerLevel.warn,
            'error': Lark.LoggerLevel.error
        }
        return levels[level] || Lark.LoggerLevel.info
    }

    async start(): Promise<void> {
        if (this.started) {
            console.log('[LarkWS] Already started')
            return
        }

        const eventDispatcher = new Lark.EventDispatcher({})
            .register({
                'im.message.receive_v1': async (data: LarkMessageEvent) => {
                    console.log('[LarkWS] ✅ Received message event:', JSON.stringify(data, null, 2))
                    await this.handleMessage(data)
                },
                'card.action.trigger': async (data: LarkCardActionEvent) => {
                    console.log('[LarkWS] 🖱️ Card action triggered:', JSON.stringify(data, null, 2))
                    const card = await this.handleCardAction(data)
                    if (card) {
                        const response = { card }
                        console.log('[LarkWS] 🎴 Card action response:', JSON.stringify(response, null, 2))
                        return response
                    }
                    console.log('[LarkWS] 🎴 No card to return')
                    return {}
                }
            })

        try {
            await this.wsClient.start({
                eventDispatcher
            })
            this.started = true

            const engine = this.config.getSyncEngine()
            if (engine) {
                this.unsubscribe = engine.subscribe((event) => this.handleSyncEvent(event))
                console.log('[LarkWS] Subscribed to SyncEngine events')
            }

            console.log('[LarkWS] WebSocket connection started')
        } catch (error) {
            console.error('[LarkWS] Failed to start:', error)
            throw error
        }
    }

    async stop(): Promise<void> {
        if (!this.started) {
            return
        }

        if (this.unsubscribe) {
            this.unsubscribe()
            this.unsubscribe = null
            console.log('[LarkWS] Unsubscribed from SyncEngine events')
        }

        try {
            await this.wsClient.stop()
            this.started = false
            console.log('[LarkWS] WebSocket connection stopped')
        } catch (error) {
            console.error('[LarkWS] Failed to stop:', error)
        }
    }

    private async handleMessage(data: LarkMessageEvent): Promise<void> {
        console.log('[LarkWS] 📨 Processing message:', {
            event_id: data.event_id,
            chat_id: data.message.chat_id,
            chat_type: data.message.chat_type,
            message_type: data.message.message_type
        })

        const event = data.message

        const eventId = data.event_id || data.message.message_id
        if (this.eventCache.has(eventId)) {
            console.log(`[LarkWS] Ignore duplicate event ${eventId}`)
            return
        }
        this.eventCache.set(eventId, true)

        const senderId = data.sender?.sender_id?.open_id
        if (event.chat_type === 'p2p' && senderId && !this.p2pChats.has(event.chat_id)) {
            this.p2pChats.set(event.chat_id, senderId)
            this.p2pUsers.set(senderId, event.chat_id)
        }

        if (event.message_type !== 'text') {
            console.log(`[LarkWS] Ignore non-text message: ${event.message_type}`)
            return
        }

        let text = ''
        try {
            const content = JSON.parse(event.content)
            text = content.text
        } catch {
            console.error('[LarkWS] Failed to parse message content')
            return
        }

        if (!text || !text.trim()) {
            console.log('[LarkWS] Ignore empty message')
            return
        }

        text = text.trim()

        const engine = this.config.getSyncEngine()
        if (!engine) {
            console.log('[LarkWS] SyncEngine not ready')
            return
        }

        let sessionId = this.chatSessions.get(event.chat_id)

        if (!sessionId) {
            const sessions = engine.getActiveSessions()
            if (sessions.length === 0) {
                console.log('[LarkWS] No active session, sending hint')
                await this.sendTextToChat(event.chat_id,
                    '⚠️ 当前没有活跃的 Session\n\n' +
                    '请先在终端启动一个 Claude Code session：\n' +
                    '```\nclaude\n```\n\n' +
                    '或使用 `/hapi_sessions` 查看可用会话，`/hapi_new` 创建新会话。'
                )
                return
            }

            const session = sessions.sort((a, b) => b.activeAt - a.activeAt)[0]
            sessionId = session.id

            this.chatSessions.set(event.chat_id, sessionId)
            this.sessionChats.set(sessionId, event.chat_id)
            console.log(`[LarkWS] Bound chat ${event.chat_id} to session ${sessionId}`)
        }

        const session = engine.getSession(sessionId)
        if (!session) {
            this.chatSessions.delete(event.chat_id)
            this.sessionChats.delete(sessionId)
            console.log('[LarkWS] Session not found, sending hint')
            await this.sendTextToChat(event.chat_id,
                '⚠️ 之前绑定的 Session 已断开\n\n' +
                '使用 `/hapi_sessions` 查看可用会话，或发送新消息自动绑定到最新活跃的 Session。'
            )
            return
        }

        console.log(`[LarkWS] Routing message to session ${sessionId}: ${text.slice(0, 50)}...`)

        if (text.startsWith('/') || text.startsWith('!') || text.startsWith('@')) {
            await this.handleSlashCommand(event.chat_id, text, senderId, event.message_id)
            return
        }

        console.log(`[LarkWS] 📤 Sending message to session ${sessionId}`)

        await this.accumulatorManager.createNew(event.chat_id, sessionId)

        await engine.sendMessage(sessionId, {
            text,
            sentFrom: 'lark'
        })
        console.log(`[LarkWS] ✅ Message sent to session ${sessionId}`)
    }

    private async handleSlashCommand(chatId: string, text: string, userId: string | undefined, messageId: string): Promise<void> {
        const engine = this.config.getSyncEngine()
        if (!engine) {
            console.log('[LarkWS] SyncEngine not ready for command')
            return
        }

        const sessionId = this.chatSessions.get(chatId)
        const session = sessionId ? engine.getSession(sessionId) : undefined
        const agentType = session?.metadata?.flavor as AgentType | undefined

        const ctx: CommandContext = {
            chatId,
            userId: userId || 'unknown',
            messageId,
            sessionId,
            session,
            agentType,
            syncEngine: engine,
            sendText: (msg: string) => this.sendTextToChat(chatId, msg),
            sendCard: (card: unknown) => this.sendCardToChat(chatId, card),
            getSessionForChat: (cid: string) => this.chatSessions.get(cid),
            setSessionForChat: (cid: string, sid: string) => {
                this.chatSessions.set(cid, sid)
                this.sessionChats.set(sid, cid)
            },
            unbindChat: (cid: string) => {
                const sid = this.chatSessions.get(cid)
                if (sid) {
                    this.sessionChats.delete(sid)
                }
                this.chatSessions.delete(cid)
            },
            getAllBindings: () => new Map(this.chatSessions),
        }

        const result = await commandRouter.execute(ctx, text)

        if (result.card) {
            await this.sendCardToChat(chatId, result.card)
        } else if (result.message) {
            await this.sendTextToChat(chatId, result.message)
        } else if (result.error) {
            await this.sendTextToChat(chatId, `❌ ${result.error}`)
        }
    }

    private async handleCardAction(data: LarkCardActionEvent): Promise<InteractiveCard | undefined> {
        const action = data.action
        console.log('[LarkWS] 🔍 Handling card action:', {
            actionName: action.name,
            actionValue: action.value,
            actionValueType: typeof action.value
        })

        switch (action.name) {
            case 'submit_create_session':
                return await this.handleCreateSessionAction(data)
            case 'submit_change_mode':
                return await this.handleChangeModeAction(data)
            case 'submit_change_model':
                return await this.handleChangeModelAction(data)
            case 'submit_close_session':
                return undefined
            case 'submit_rename_session':
                return await this.handleRenameSessionAction(data)
            case 'submit_switch_session':
                return await this.handleSwitchSessionAction(data)
            default:
                const value = action.value
                if (typeof value === 'string') {
                    if (value.startsWith('close:') || value === 'cancel_close') {
                        return await this.handleCloseSessionAction(data)
                    } else if (value.startsWith('notify:')) {
                        return await this.handleNotifyAction(data)
                    } else if (value.startsWith('settings_tab:')) {
                        return await this.handleSettingsTabAction(data)
                    } else if (value.startsWith('stats_tab:')) {
                        return await this.handleStatsTabAction(data)
                    }
                } else if (typeof value === 'object' && value !== null) {
                    const actionValue = (value as { action?: string }).action
                    if (typeof actionValue === 'string' && actionValue.startsWith('settings_tab:')) {
                        data.action.value = actionValue
                        return await this.handleSettingsTabAction(data)
                    } else if (typeof actionValue === 'string' && actionValue.startsWith('stats_tab:')) {
                        data.action.value = actionValue
                        return await this.handleStatsTabAction(data)
                    }
                }
                return undefined
        }
    }

    private async handleNotifyAction(data: LarkCardActionEvent): Promise<InteractiveCard | undefined> {
        const value = data.action.value as string
        const chatId = data.context.open_chat_id
        const messageId = data.context.open_message_id
        const state = value.split(':')[1]

        if (state !== 'on' && state !== 'off') return undefined

        const enabled = state === 'on'
        setNotifyState(chatId, enabled)

        return buildNotifyCard(enabled) as InteractiveCard
    }

    private async handleSettingsTabAction(data: LarkCardActionEvent): Promise<InteractiveCard | undefined> {
        const value = data.action.value as string
        const parts = value.split(':')
        if (parts.length < 3) return undefined

        const sessionId = parts[1]
        const tabName = parts[2] as SettingsTab
        const messageId = data.context.open_message_id

        const engine = this.config.getSyncEngine()
        if (!engine) return undefined

        const session = engine.getSession(sessionId)
        if (!session) {
            return new LarkCardBuilder()
                .setHeader('❌ Error', undefined, 'red')
                .addMarkdown('Session not found or expired.')
                .build()
        }

        const card = buildSettingsCard(session, tabName)

        return card as InteractiveCard
    }

    private async handleStatsTabAction(data: LarkCardActionEvent): Promise<InteractiveCard | undefined> {
        const value = data.action.value as string
        const parts = value.split(':')
        if (parts.length < 2) return undefined

        const tabName = parts[1] as StatsTab
        const messageId = data.context.open_message_id

        const engine = this.config.getSyncEngine()
        if (!engine) return undefined

        const sessions = engine.getSessions()
        const machines = engine.getMachines()
        const dbStats = engine.getStats()

        const card = buildStatsCard({
            sessions,
            machines,
            dbStats
        }, tabName)

        console.log('[LarkWS] 📊 Stats tab action:', { tabName, messageId })

        try {
            await this.larkClient.patchMessage({
                openMessageId: messageId,
                card
            })
        } catch (err) {
            console.error('[LarkWS] Failed to patch stats card:', err)
        }

        return card as InteractiveCard
    }

    private async handleChangeModeAction(data: LarkCardActionEvent): Promise<InteractiveCard | undefined> {
        const form = data.action.form_value
        const value = data.action.value as Record<string, string>
        const sessionId = value.session_id
        const mode = form?.mode

        if (!sessionId || !mode) return undefined

        const engine = this.config.getSyncEngine()
        if (!engine) return undefined

        try {
            await engine.setPermissionMode(sessionId, mode as any)

            return new LarkCardBuilder()
                .setHeader('✅ Mode Updated', undefined, 'green')
                .addMarkdown(`Permission mode changed to **${mode}**`)
                .build()
        } catch (error) {
            console.error('[LarkWS] Failed to change mode:', error)
            return undefined
        }
    }

    private async handleChangeModelAction(data: LarkCardActionEvent): Promise<InteractiveCard | undefined> {
        const form = data.action.form_value
        const value = data.action.value as Record<string, string>
        const sessionId = value.session_id
        const model = form?.model

        if (!sessionId || !model) return undefined

        const engine = this.config.getSyncEngine()
        if (!engine) return undefined

        try {
            await engine.setModelMode(sessionId, model as any)

            return new LarkCardBuilder()
                .setHeader('✅ Model Updated', undefined, 'green')
                .addMarkdown(`Model mode changed to **${model}**`)
                .build()
        } catch (error) {
            console.error('[LarkWS] Failed to change model:', error)
            return undefined
        }
    }

    private async handleCloseSessionAction(data: LarkCardActionEvent): Promise<InteractiveCard | undefined> {
        const value = data.action.value as string

        if (value === 'cancel_close') {
            return new LarkCardBuilder()
                .setHeader('❌ Cancelled', undefined, 'grey')
                .addMarkdown('Operation cancelled')
                .build()
        }

        const sessionId = value.split(':')[1]
        if (!sessionId) return undefined

        const engine = this.config.getSyncEngine()
        if (!engine) return undefined

        try {
            await engine.closeSession(sessionId)

            const chatId = data.context.open_chat_id
            const currentBound = this.chatSessions.get(chatId)
            if (currentBound === sessionId) {
                this.unbindChat(chatId)
            }

            return new LarkCardBuilder()
                .setHeader('✅ Session Closed', undefined, 'green')
                .addMarkdown(`Session **${sessionId.slice(0, 8)}** has been closed.`)
                .build()
        } catch (error) {
            console.error('[LarkWS] Failed to close session:', error)
            return undefined
        }
    }

    private async handleRenameSessionAction(data: LarkCardActionEvent): Promise<InteractiveCard | undefined> {
        const form = data.action.form_value
        const value = data.action.value as Record<string, string>
        const sessionId = value.session_id
        const newName = form?.new_name

        if (!sessionId || !newName) return undefined

        const engine = this.config.getSyncEngine()
        if (!engine) return undefined

        try {
            await engine.renameSession(sessionId, newName)

            return new LarkCardBuilder()
                .setHeader('✅ Renamed', undefined, 'green')
                .addMarkdown(`Session renamed to **${newName}**`)
                .build()
        } catch (error) {
            console.error('[LarkWS] Failed to rename session:', error)
            return undefined
        }
    }

    private async handleSwitchSessionAction(data: LarkCardActionEvent): Promise<InteractiveCard | undefined> {
        const form = data.action.form_value
        const chatId = data.context.open_chat_id
        const sessionId = form?.session_id

        if (!sessionId) return undefined

        const engine = this.config.getSyncEngine()
        if (!engine) return undefined

        try {
            const session = engine.getSession(sessionId)
            if (!session) {
                throw new Error('Session not found')
            }

            this.bindChatToSession(chatId, sessionId)
            this.sessionChats.set(sessionId, chatId)

            const messages = engine.getSessionMessages(sessionId)
            return buildSessionInfoCard({
                session,
                messageCount: messages.length,
                isCurrent: true
            }) as InteractiveCard
        } catch (error) {
            console.error('[LarkWS] Failed to switch session:', error)
            return new LarkCardBuilder()
                .setHeader('❌ Failed', undefined, 'red')
                .addMarkdown(`Error: ${error}`)
                .build()
        }
    }

    private async handleCreateSessionAction(data: LarkCardActionEvent): Promise<InteractiveCard | undefined> {
        const form = data.action.form_value
        const chatId = data.context.open_chat_id
        const messageId = data.context.open_message_id

        if (!form || !chatId) return undefined

        const machineId = form.machine_id
        const agentType = form.agent_type
        const path = form.path
        const options = form.options || []

        if (!machineId || !agentType || !path) {
            console.error('[LarkWS] Missing fields in create session form')
            return undefined
        }

        const engine = this.config.getSyncEngine()
        if (!engine) return undefined

        const creatingCard = new LarkCardBuilder()
            .setHeader('🚀 Creating Session...', undefined, 'wathet')
            .addMarkdown(`Machine: \`${machineId}\`\nPath: \`${path}\``)
            .build()

        this.createSessionAsync(data, engine, machineId, agentType, path, options, chatId, messageId)

        return creatingCard
    }

    private async createSessionAsync(
        _data: LarkCardActionEvent,
        engine: SyncEngine,
        machineId: string,
        agentType: 'claude' | 'gemini' | 'codex' | undefined,
        path: string,
        options: string[],
        chatId: string,
        messageId: string
    ): Promise<void> {
        try {
            const machines = engine.getMachines()
            const machine = machines.find(m => m.id === machineId)

            if (!machine) {
                throw new Error(`Machine not found: ${machineId}`)
            }

            const yolo = options.includes('yolo')

            const result = await engine.spawnSession(
                machineId,
                path,
                agentType,
                yolo
            )

            if (result.type === 'error') {
                throw new Error(result.message)
            }

            const sessionId = result.sessionId

            await new Promise(r => setTimeout(r, 1000))

            const session = engine.getSession(sessionId)

            if (session) {
                this.bindChatToSession(chatId, session.id)
                this.sessionChats.set(session.id, chatId)

                const messages = engine.getSessionMessages(session.id)
                const card = buildSessionInfoCard({
                    session,
                    messageCount: messages.length,
                    isCurrent: true
                })

                await this.larkClient.patchMessage({
                    openMessageId: messageId,
                    card
                })
            } else {
                await this.larkClient.patchMessage({
                    openMessageId: messageId,
                    card: new LarkCardBuilder()
                        .setHeader('⏳ Session Created', undefined, 'blue')
                        .addMarkdown(`Session **${sessionId.slice(0, 8)}** created on **${machine.metadata?.host}**.\n\nPath: \`${path}\``)
                        .addNote('Waiting for session data to sync...')
                        .build()
                })
            }

        } catch (error) {
            console.error('[LarkWS] Failed to create session:', error)
            await this.larkClient.patchMessage({
                openMessageId: messageId,
                card: new LarkCardBuilder()
                    .setHeader('❌ Failed', undefined, 'red')
                    .addMarkdown(`Error: ${error}`)
                    .build()
            })
        }
    }

    private handleSyncEvent(event: SyncEvent): void {
        console.log('[LarkWS] 📥 SyncEvent received:', {
            type: event.type,
            sessionId: event.sessionId,
            hasMessage: !!event.message,
            hasData: !!event.data
        })

        if (event.type === 'message-received' && event.sessionId) {
            const chatId = this.sessionChats.get(event.sessionId)

            if (!chatId) {
                console.log('[LarkWS] ⚠️ No chat bound to session, skipping')
                return
            }

            const message = event.message?.content ?? event.data
            const shouldFinalize = this.accumulateMessage(chatId, event.sessionId, message)

            if (shouldFinalize) {
                this.accumulatorManager.finalize(chatId, event.sessionId).catch(err => {
                    console.error('[LarkWS] Failed to finalize accumulator:', err)
                })
            }
        }
    }

    private accumulateMessage(chatId: string, sessionId: string, message: unknown): boolean {
        if (!message || typeof message !== 'object') return false

        const acc = this.accumulatorManager.getOrCreate(chatId, sessionId)
        const msg = message as AgentMessage | AgentOutputMessage
        let shouldFinalize = false

        if ((msg.role === 'assistant' || msg.role === 'user') && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === 'text') {
                    if (msg.role === 'assistant') {
                        acc.addText(block.text)
                    }
                } else if (block.type === 'thinking') {
                    acc.addThinking(block.thinking)
                } else if (block.type === 'tool_use') {
                    acc.startTool(block.id, block.name, block.input)
                } else if (block.type === 'tool_result') {
                    let content = ''
                    if (typeof block.content === 'string') {
                        content = block.content
                    } else if (Array.isArray(block.content)) {
                        content = block.content.map(c => c.text).join('\n')
                    }
                    acc.completeTool(block.tool_use_id, content, !!block.is_error)
                }
            }
        }

        if (msg.role === 'agent') {
            const agentMsg = msg as AgentOutputMessage
            const content = agentMsg.content
            if (content?.type === 'output') {
                const data = content.data
                if (data?.type === 'assistant' && data.message) {
                    return this.accumulateMessage(chatId, sessionId, data.message)
                }
                if (data?.type === 'user' && data.message) {
                    return this.accumulateMessage(chatId, sessionId, data.message)
                }
                if (data?.type === 'result' || data?.type === 'summary') {
                    shouldFinalize = true
                }
            }
        }

        return shouldFinalize
    }

    getConnectionState(): {
        connected: boolean
        isConnecting: boolean
        chatBindings: number
        p2pChats: number
    } {
        return {
            connected: this.started,
            isConnecting: false,
            chatBindings: this.chatSessions.size,
            p2pChats: this.p2pChats.size
        }
    }

    bindChatToSession(chatId: string, sessionId: string): void {
        this.chatSessions.set(chatId, sessionId)
        console.log(`[LarkWS] Manually bound chat ${chatId} to session ${sessionId}`)
    }

    unbindChat(chatId: string): void {
        this.chatSessions.delete(chatId)
        console.log(`[LarkWS] Unbound chat ${chatId}`)
    }

    getSessionForChat(chatId: string): string | undefined {
        return this.chatSessions.get(chatId)
    }

    async sendTextToChat(chatId: string, text: string): Promise<void> {
        try {
            await this.larkClient.sendText({
                receiveIdType: 'chat_id',
                receiveId: chatId,
                text
            })
            console.log(`[LarkWS] Sent text to chat ${chatId}`)
        } catch (error) {
            console.error(`[LarkWS] Failed to send text to chat ${chatId}:`, error)
        }
    }

    async sendCardToChat(chatId: string, card: unknown): Promise<void> {
        try {
            await this.larkClient.sendInteractive({
                receiveIdType: 'chat_id',
                receiveId: chatId,
                card
            })
            console.log(`[LarkWS] Sent card to chat ${chatId}`)
        } catch (error) {
            console.error(`[LarkWS] Failed to send card to chat ${chatId}:`, error)
        }
    }
}
