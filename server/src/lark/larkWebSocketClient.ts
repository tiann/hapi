import * as Lark from '@larksuiteoapi/node-sdk'
import { LRUCache } from 'lru-cache'
import type { SyncEngine, SyncEvent } from '../sync/syncEngine'
import { LarkClient } from './larkClient'
import { convertMessageToLark, type ConvertedMessage } from './messageConverter'
import { commandRouter, initializeCommands, type CommandContext, type AgentType } from '../commands'

export interface LarkWSClientConfig {
    appId: string
    appSecret: string
    getSyncEngine: () => SyncEngine | null
    domain?: string
    logLevel?: 'info' | 'debug' | 'warn' | 'error'
}

export interface LarkMessageEvent {
    event_id: string
    message: {
        message_id: string
        chat_id: string
        chat_type: 'p2p' | 'group'
        message_type: string
        content: string
    }
    sender: {
        sender_id: {
            open_id: string
            user_id?: string
        }
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
    private toolMessageIds: LRUCache<string, string>
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
        this.toolMessageIds = new LRUCache<string, string>({
            max: 500,
            ttl: 300000
        })

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

        if (this.eventCache.has(data.event_id)) {
            console.log(`[LarkWS] Ignore duplicate event ${data.event_id}`)
            return
        }
        this.eventCache.set(data.event_id, true)

        if (event.chat_type === 'p2p' && !this.p2pChats.has(event.chat_id)) {
            this.p2pChats.set(event.chat_id, data.sender.sender_id.open_id)
            this.p2pUsers.set(data.sender.sender_id.open_id, event.chat_id)
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
                console.log('[LarkWS] No active session')
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
            console.log('[LarkWS] Session not found, cleared binding')
            return
        }

        console.log(`[LarkWS] Routing message to session ${sessionId}: ${text.slice(0, 50)}...`)

        if (text.startsWith('/') || text.startsWith('!') || text.startsWith('@')) {
            await this.handleSlashCommand(event.chat_id, text, data.sender.sender_id.open_id, event.message_id)
            return
        }

        await engine.sendMessage(sessionId, {
            text,
            sentFrom: 'lark'
        })
    }

    private async handleSlashCommand(chatId: string, text: string, userId: string, messageId: string): Promise<void> {
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
            userId,
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

    private handleSyncEvent(event: SyncEvent): void {
        const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1'

        if (DEBUG) {
            console.log('[LarkWS] 📥 SyncEvent received:', {
                type: event.type,
                sessionId: event.sessionId,
                hasMessage: !!event.message,
                hasData: !!event.data
            })
        }

        if (event.type === 'message-received' && event.sessionId) {
            const chatId = this.sessionChats.get(event.sessionId)

            if (DEBUG) {
                console.log('[LarkWS] 🔍 Looking up chat for session:', {
                    sessionId: event.sessionId,
                    chatId: chatId || 'NOT_FOUND',
                    totalBindings: this.sessionChats.size,
                    allBindings: Array.from(this.sessionChats.entries())
                })
            }

            if (!chatId) {
                if (DEBUG) {
                    console.log('[LarkWS] ⚠️ No chat bound to session, skipping')
                }
                return
            }

            const message = event.message?.content ?? event.data

            if (DEBUG) {
                console.log('[LarkWS] 📝 Message content to convert:', {
                    type: typeof message,
                    keys: message && typeof message === 'object' ? Object.keys(message) : [],
                    preview: JSON.stringify(message).slice(0, 200)
                })
            }

            const converted = convertMessageToLark(message)

            if (DEBUG) {
                console.log('[LarkWS] 🔄 Converted messages:', {
                    count: converted.length,
                    types: converted.map(m => m.type)
                })
            }

            if (converted.length > 0) {
                console.log(`[LarkWS] 📤 Sending ${converted.length} message(s) to chat ${chatId}`)
                this.sendConvertedMessagesToChat(chatId, converted).catch(err => {
                    console.error('[LarkWS] ❌ Failed to send messages to chat:', err)
                })
            } else {
                if (DEBUG) {
                    console.log('[LarkWS] ⚠️ No messages to send after conversion')
                }
            }
        }
    }

    private async sendConvertedMessagesToChat(chatId: string, messages: ConvertedMessage[]): Promise<void> {
        for (const msg of messages) {
            try {
                if (msg.type === 'text') {
                    await this.larkClient.sendText({
                        receiveIdType: 'chat_id',
                        receiveId: chatId,
                        text: msg.content as string
                    })
                    console.log(`[LarkWS] Sent text to chat ${chatId}`)
                } else if (msg.toolUseId) {
                    const existingMessageId = this.toolMessageIds.get(msg.toolUseId)
                    if (existingMessageId && msg.isToolResult) {
                        await this.larkClient.patchMessage({
                            openMessageId: existingMessageId,
                            card: msg.content
                        })
                        console.log(`[LarkWS] Updated tool message ${existingMessageId} for tool ${msg.toolUseId}`)
                        this.toolMessageIds.delete(msg.toolUseId)
                    } else if (!existingMessageId && !msg.isToolResult) {
                        const messageId = await this.larkClient.sendInteractive({
                            receiveIdType: 'chat_id',
                            receiveId: chatId,
                            card: msg.content
                        })
                        if (messageId) {
                            this.toolMessageIds.set(msg.toolUseId, messageId)
                            console.log(`[LarkWS] Sent tool card to chat ${chatId}, messageId=${messageId}`)
                        }
                    }
                } else {
                    await this.larkClient.sendInteractive({
                        receiveIdType: 'chat_id',
                        receiveId: chatId,
                        card: msg.content
                    })
                    console.log(`[LarkWS] Sent card to chat ${chatId}`)
                }
            } catch (error) {
                console.error(`[LarkWS] Failed to send message to chat ${chatId}:`, error)
            }
        }
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
