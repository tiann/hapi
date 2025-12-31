import Lark from '@larksuiteoapi/node-sdk'
import { LRUCache } from 'lru-cache'
import type { SyncEngine } from '../sync/syncEngine'

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
    private eventCache: LRUCache<string, boolean>
    private p2pChats: Map<string, string>
    private p2pUsers: Map<string, string>
    private chatSessions: Map<string, string>
    private config: LarkWSClientConfig
    private started = false

    constructor(config: LarkWSClientConfig) {
        this.config = config
        
        this.eventCache = new LRUCache<string, boolean>({
            max: 1000,
            ttl: 3600000
        })
        
        this.p2pChats = new Map()
        this.p2pUsers = new Map()
        this.chatSessions = new Map()
        
        const logLevel = this.getLogLevel(config.logLevel || 'info')
        
        this.wsClient = new Lark.WSClient({
            appId: config.appId,
            appSecret: config.appSecret,
            domain: config.domain || 'https://open.feishu.cn',
            loggerLevel: logLevel
        })
        
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
                    await this.handleMessage(data)
                }
            })

        try {
            await this.wsClient.start({
                eventDispatcher
            })
            this.started = true
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

        try {
            await this.wsClient.stop()
            this.started = false
            console.log('[LarkWS] WebSocket connection stopped')
        } catch (error) {
            console.error('[LarkWS] Failed to stop:', error)
        }
    }

    private async handleMessage(data: LarkMessageEvent): Promise<void> {
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
            console.log(`[LarkWS] Bound chat ${event.chat_id} to session ${sessionId}`)
        }

        const session = engine.getSession(sessionId)
        if (!session) {
            this.chatSessions.delete(event.chat_id)
            console.log('[LarkWS] Session not found, cleared binding')
            return
        }

        console.log(`[LarkWS] Routing message to session ${sessionId}: ${text.slice(0, 50)}...`)
        
        await engine.sendMessage(sessionId, {
            text,
            sentFrom: 'lark'
        })
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
}
