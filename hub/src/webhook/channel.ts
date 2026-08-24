import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { VisibilityTracker } from '../visibility/visibilityTracker'

function buildSessionUrl(baseUrl: string, sessionId: string): string {
    try {
        return new URL(`/sessions/${sessionId}`, baseUrl).toString()
    } catch {
        const normalized = baseUrl.replace(/\/+$/, '')
        return `${normalized}/sessions/${sessionId}`
    }
}

/**
 * Generic webhook notification channel.
 *
 * Unlike ServerChanChannel/HappyBot, this channel does not talk to a fixed
 * provider. It POSTs a small JSON payload to a user-supplied URL, so it
 * works with self-hosted relays, serverless functions, or any third-party
 * push gateway that accepts a webhook (e.g. Bark, PushPlus, WxPusher, a
 * custom Cloudflare Worker that fans out to Telegram/Server酱/whatever).
 *
 * This is also the escape hatch for hubs that cannot reach the built-in
 * providers directly (e.g. sctapi.ftqq.com / api.telegram.org are
 * unreachable from the hub's network): point HAPI_WEBHOOK_URL at any
 * endpoint the hub *can* reach, and let that endpoint forward the message.
 *
 * Payload:
 * {
 *   "event": "ready" | "permission" | "task_failed" | "completed",
 *   "title": string,
 *   "content": string,
 *   "url": string,        // deep link to the session
 *   "sessionId": string
 * }
 *
 * If a key is configured, it is sent two ways for maximum compatibility
 * with existing webhook receivers: as a `key` query parameter on the URL
 * (matching the convention used by Server酱/PushPlus-style APIs) and as an
 * `X-HAPI-Webhook-Key` header.
 */
export class WebhookChannel implements NotificationChannel {
    constructor(
        private readonly url: string,
        private readonly key: string | null,
        private readonly publicUrl: string,
        private readonly visibilityTracker: VisibilityTracker | null = null,
        private readonly backgroundOnly = false
    ) {}

    async sendReady(session: Session): Promise<void> {
        if (!session.active || this.shouldSuppress(session)) {
            return
        }

        const agentName = getAgentName(session)
        await this.send('ready', 'HAPI Ready for input', `${agentName} 正在等待输入`, session)
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active || this.shouldSuppress(session)) {
            return
        }

        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests)[0]
            : null
        const toolName = request?.tool ? ` (${request.tool})` : ''
        await this.send('permission', 'HAPI Permission Request', `需要授权${toolName}`, session)
    }

    async sendTaskNotification(session: Session, notification: TaskNotification): Promise<void> {
        if (!session.active || this.shouldSuppress(session)) {
            return
        }

        const status = notification.status?.trim().toLowerCase()
        const isFailure = status === 'failed' || status === 'error' || status === 'killed' || status === 'aborted'
        if (!isFailure) {
            return
        }
        await this.send('task_failed', 'HAPI Task failed', notification.summary, session)
    }

    async sendSessionCompletion(session: Session, _reason: SessionEndReason): Promise<void> {
        if (this.shouldSuppress(session)) {
            return
        }

        await this.send('completed', 'HAPI Session completed', '会话已结束。', session)
    }

    private async send(event: string, title: string, content: string, session: Session): Promise<void> {
        const name = getSessionName(session)
        const sessionUrl = buildSessionUrl(this.publicUrl, session.id)

        let target: URL
        try {
            target = new URL(this.url)
        } catch {
            throw new Error(`Webhook 发送失败: 无效的 URL "${this.url}"`)
        }
        if (this.key) {
            target.searchParams.set('key', this.key)
        }

        const response = await fetch(target, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(this.key ? { 'x-hapi-webhook-key': this.key } : {})
            },
            body: JSON.stringify({
                event,
                title: `${title} · ${name}`,
                content,
                url: sessionUrl,
                sessionId: session.id
            })
        })

        if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new Error(`Webhook 发送失败: HTTP ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`)
        }
    }

    private shouldSuppress(session: Session): boolean {
        return this.backgroundOnly
            && this.visibilityTracker !== null
            && this.visibilityTracker.hasVisibleConnection(session.namespace)
    }
}
