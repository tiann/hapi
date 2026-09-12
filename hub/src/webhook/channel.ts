import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import { requireWebhookHttpUrl } from './url'

export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000

function buildSessionUrl(baseUrl: string, sessionId: string): string {
    try {
        return new URL(`/sessions/${sessionId}`, baseUrl).toString()
    } catch {
        const normalized = baseUrl.replace(/\/+$/, '')
        return `${normalized}/sessions/${sessionId}`
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/**
 * Generic webhook notification channel.
 *
 * Unlike ServerChanChannel/HappyBot, this channel does not talk to a fixed
 * provider. It POSTs HAPI's JSON payload to a user-supplied URL. Point this
 * at a relay you control (self-hosted endpoint, serverless function, Worker)
 * and have that relay forward to Telegram / Server酱 / Bark / etc.
 *
 * This is also the escape hatch for hubs that cannot reach the built-in
 * providers directly (e.g. sctapi.ftqq.com / api.telegram.org are
 * unreachable from the hub's network).
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
    private readonly url: string
    private readonly key: string | null

    constructor(
        url: string,
        key: string | null,
        private readonly publicUrl: string,
        private readonly visibilityTracker: VisibilityTracker | null = null,
        private readonly backgroundOnly = false
    ) {
        this.url = requireWebhookHttpUrl(url)
        this.key = key?.trim() ? key.trim() : null
    }

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

        const target = new URL(this.url)
        if (this.key) {
            target.searchParams.set('key', this.key)
        }

        let response: Response
        try {
            response = await fetch(target, {
                method: 'POST',
                redirect: 'error',
                headers: {
                    'content-type': 'application/json',
                    ...(this.key ? { 'X-HAPI-Webhook-Key': this.key } : {})
                },
                body: JSON.stringify({
                    event,
                    title: `${title} · ${name}`,
                    content,
                    url: sessionUrl,
                    sessionId: session.id
                }),
                signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS)
            })
        } catch (error) {
            if (isAbortError(error)) {
                throw new Error('Webhook 发送失败: 请求超时')
            }
            throw new Error(`Webhook 发送失败: ${error instanceof Error ? error.message : String(error)}`)
        }

        if (!response.ok) {
            throw new Error(`Webhook 发送失败: HTTP ${response.status} ${response.statusText}`)
        }
    }

    private shouldSuppress(session: Session): boolean {
        return this.backgroundOnly
            && this.visibilityTracker !== null
            && this.visibilityTracker.hasVisibleConnection(session.namespace)
    }
}
