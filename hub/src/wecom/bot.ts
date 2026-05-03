import type { SessionEndReason } from '@hapi/protocol'
import type { Session, SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'
import type {
    NotificationChannel,
    TaskNotification
} from '../notifications/notificationTypes'
import { isFailureStatus } from '../notifications/notificationTypes'
import { WSClient, type WsFrame, type WSClientOptions } from '@wecom/aibot-node-sdk'
import type { EventMessageWith, SendMsgBody, TemplateCard, TemplateCardEventData } from './types'
import { handleTemplateCardEvent, type CallbackCtx } from './callbacks'
import {
    buildPermissionCard,
    buildReadyCard,
    buildSessionCompletionCard,
    buildTaskCard
} from './sessionView'

/** 30 s cooldown before we try to reconnect after a server-initiated kick. */
const SERVER_KICK_RECONNECT_DELAY_MS = 30_000

/**
 * Shape of the WeCom SDK client that WecomBot needs. Kept narrow on purpose
 * so tests can supply a fake (an EventEmitter-backed stub) without having to
 * construct a real {@link WSClient}.
 */
export interface WecomBotClient {
    connect(): unknown
    disconnect(): void
    on(event: 'message.text', handler: (frame: WsFrame) => void): unknown
    on(event: 'event.template_card_event', handler: (frame: WsFrame) => void): unknown
    on(event: 'event.disconnected_event', handler: (frame: WsFrame) => void): unknown
    on(event: 'disconnected', handler: (reason: string) => void): unknown
    on(event: 'error', handler: (err: Error) => void): unknown
    sendMessage(chatid: string, body: SendMsgBody): Promise<WsFrame>
    updateTemplateCard(
        frame: { headers: { req_id: string } },
        templateCard: TemplateCard,
        userids?: string[]
    ): Promise<WsFrame>
}

export interface WecomBotConfig {
    botId: string
    secret: string
    cliApiToken: string
    publicUrl: string
    store: Store
    syncEngine: SyncEngine
    /** Pre-constructed client; if omitted, a real WSClient from the SDK is used. */
    client?: WecomBotClient
    /** Additional SDK options forwarded when no {@link client} is provided. */
    clientOptions?: Partial<Omit<WSClientOptions, 'botId' | 'secret' | 'logger'>>
    /** Optional logger; falls back to console. Supports optional debug level. */
    logger?: {
        debug?: (msg: string, ...args: unknown[]) => void
        info?: (msg: string, ...args: unknown[]) => void
        warn?: (msg: string, ...args: unknown[]) => void
        error?: (msg: string, ...args: unknown[]) => void
    }
}

export class WecomBot implements NotificationChannel {
    private readonly store: Store
    private readonly syncEngine: SyncEngine
    private readonly cliApiToken: string
    private readonly publicUrl: string
    private readonly client: WecomBotClient
    private readonly logger: NonNullable<WecomBotConfig['logger']>
    private stopped = false
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null

    constructor(config: WecomBotConfig) {
        this.store = config.store
        this.syncEngine = config.syncEngine
        this.cliApiToken = config.cliApiToken
        this.publicUrl = config.publicUrl
        this.logger = config.logger ?? {}
        this.client = config.client ?? new WSClient({
            botId: config.botId,
            secret: config.secret,
            logger: this.adaptLogger(),
            ...config.clientOptions
        })

        this.client.on('message.text', (frame) => this.onTextMessage(frame))
        this.client.on('event.template_card_event', (frame) => this.onEvent(frame))
        this.client.on('event.disconnected_event', () => this.scheduleReconnectAfterKick())
        this.client.on('error', (err) => {
            (this.logger.error ?? console.error)('[WecomBot] client error:', err)
        })
    }

    start(): void {
        this.stopped = false
        this.client.connect()
    }

    stop(): void {
        this.stopped = true
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        this.client.disconnect()
    }

    // --- NotificationChannel ---

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) return
        const card = buildPermissionCard(session, this.publicUrl)
        if (!card) return
        await this.broadcast(session.namespace, {
            msgtype: 'template_card',
            template_card: card
        })
    }

    async sendReady(session: Session): Promise<void> {
        if (!session.active) return
        const card = buildReadyCard(session, this.publicUrl)
        await this.broadcast(session.namespace, {
            msgtype: 'template_card',
            template_card: card
        })
    }

    async sendTaskNotification(session: Session, notification: TaskNotification): Promise<void> {
        if (!session.active) return
        if (!isFailureStatus(notification.status)) return
        const card = buildTaskCard(session, notification, this.publicUrl)
        await this.broadcast(session.namespace, {
            msgtype: 'template_card',
            template_card: card
        })
    }

    async sendSessionCompletion(session: Session, _reason: SessionEndReason): Promise<void> {
        const card = buildSessionCompletionCard(session, this.publicUrl)
        await this.broadcast(session.namespace, {
            msgtype: 'template_card',
            template_card: card
        })
    }

    // --- Helpers ---

    private async broadcast(namespace: string, body: SendMsgBody): Promise<void> {
        const chatids = this.bindingsFor(namespace)
        for (const chatid of chatids) {
            try {
                await this.client.sendMessage(chatid, body)
            } catch (err) {
                // One bad chatid shouldn't abort the rest of the fan-out.
                (this.logger.warn ?? console.warn)(
                    `[WecomBot] sendMessage to ${chatid} failed:`, err
                )
            }
        }
    }

    // --- Incoming frames ---

    private onTextMessage(frame: WsFrame): void {
        const body = frame.body as { text?: { content?: string }; from?: { userid?: string } } | undefined
        const content = body?.text?.content?.trim()
        const userid = body?.from?.userid
        if (!content || !userid) return

        const prefix = `${this.cliApiToken}:`
        if (!content.startsWith(prefix)) return
        const namespace = content.slice(prefix.length).trim()
        if (!namespace) return

        // Whitelist: letters, digits, dash, underscore, up to 64 chars.
        // Rejects markdown metacharacters that would break the confirmation
        // card and keeps the `users.namespace` column to a known charset.
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) {
            void this.sendBindReply(userid,
                'Invalid namespace. Allowed: letters, digits, `-`, `_`, max 64 chars.')
            return
        }

        const existing = this.store.users.getUser('wecom', userid)
        if (existing) {
            if (existing.namespace === namespace) {
                void this.sendBindReply(userid,
                    `Already bound to namespace **${namespace}**.`)
            } else {
                // Refuse to silently no-op: surface the conflict.
                void this.sendBindReply(userid,
                    `Already bound to a different namespace. Unbind first before rebinding.`)
            }
            return
        }

        try {
            this.store.users.addUser('wecom', userid, namespace)
        } catch (err) {
            (this.logger.error ?? console.error)('[WecomBot] failed to persist binding:', err)
            return
        }
        void this.sendBindReply(userid,
            `Bound WeCom user **${userid}** to namespace **${namespace}**.`)
    }

    private async sendBindReply(chatid: string, content: string): Promise<void> {
        try {
            await this.client.sendMessage(chatid, {
                msgtype: 'markdown',
                markdown: { content }
            })
        } catch (err) {
            (this.logger.warn ?? console.warn)(
                `[WecomBot] bind reply to ${chatid} failed:`, err
            )
        }
    }

    private onEvent(frame: WsFrame): void {
        const typedFrame = frame as WsFrame<EventMessageWith<TemplateCardEventData>>
        const event = typedFrame.body?.event
        if (!event || event.eventtype !== 'template_card_event') return

        const details =
            (event as { template_card_event?: { event_key?: string; task_id?: string } })
                .template_card_event ?? {}
        const eventKey = details.event_key ?? event.event_key
        const taskId = details.task_id ?? event.task_id
        this.logger.debug?.(
            `[WecomBot] onEvent event_key=${eventKey ?? '(none)'} task_id=${taskId ?? '(none)'}`
        )

        const ctx: CallbackCtx = {
            syncEngine: this.syncEngine,
            store: this.store,
            publicUrl: this.publicUrl,
            sendUpdate: (payload) => {
                this.logger.debug?.(
                    `[WecomBot] update_template_card req_id=${payload.frame.headers.req_id} task_id=${payload.card.task_id ?? '(none)'}`
                )
                // The SDK threads frame.headers.req_id onto the outgoing frame
                // and enforces the 5-second reply window.
                void this.client.updateTemplateCard(payload.frame, payload.card, payload.userids)
                    .catch((err) => {
                        (this.logger.error ?? console.error)(
                            '[WecomBot] updateTemplateCard failed:', err
                        )
                    })
            }
        }
        void handleTemplateCardEvent(typedFrame, ctx).catch((err) => {
            (this.logger.error ?? console.error)('[WecomBot] handleTemplateCardEvent failed:', err)
        })
    }

    private scheduleReconnectAfterKick(): void {
        // The SDK treats disconnected_event as a manual close and will not
        // auto-reconnect. Re-arm the connection after a cooldown so a second
        // connection (e.g., another dev starting the hub) only briefly takes
        // us offline instead of requiring a manual restart.
        if (this.stopped) return
        if (this.reconnectTimer) return
        (this.logger.warn ?? console.warn)(
            `[WecomBot] server kicked this connection; reconnecting in ${SERVER_KICK_RECONNECT_DELAY_MS}ms`
        )
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            if (this.stopped) return
            try {
                this.client.connect()
            } catch (err) {
                (this.logger.error ?? console.error)(
                    '[WecomBot] reconnect after kick failed:', err
                )
            }
        }, SERVER_KICK_RECONNECT_DELAY_MS)
    }

    private bindingsFor(namespace: string): string[] {
        return this.store.users
            .getUsersByPlatformAndNamespace('wecom', namespace)
            .map((u) => u.platformUserId)
    }

    private adaptLogger() {
        const l = this.logger
        return {
            debug: (msg: string, ...args: unknown[]) => l.debug?.(msg, ...args),
            info: (msg: string, ...args: unknown[]) => (l.info ?? console.log)(msg, ...args),
            warn: (msg: string, ...args: unknown[]) => (l.warn ?? console.warn)(msg, ...args),
            error: (msg: string, ...args: unknown[]) => (l.error ?? console.error)(msg, ...args)
        }
    }
}
