import type { ServerChanErrorDestination } from '../config/notificationDestinations'
import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import type { NotificationChannel } from '../notifications/notificationTypes'
import { buildSessionUrl, getAgentName, getSessionName } from '../notifications/sessionInfo'
import { shouldSuppressBackgroundNotification } from '../notifications/backgroundOnly'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import { composeInputRequestNotification, getFirstPendingRequest } from '../notifications/inputRequest'

export class ServerChanChannel implements NotificationChannel {
    constructor(
        private readonly sendKey: string | null,
        private readonly publicUrl: string,
        private readonly visibilityTracker: VisibilityTracker | null = null,
        private readonly backgroundOnly = false,
        private readonly errorDestinations: ReadonlyMap<string, ServerChanErrorDestination> = new Map()
    ) {}

    async sendReady(session: Session): Promise<void> {
        if (!this.sendKey || !session.active || this.shouldSuppress(session)) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send(this.sendKey, 'HAPI Ready for input', `${agentName} 正在等待输入\n\n会话：${name}\n\n${url}`)
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!this.sendKey || !session.active || this.shouldSuppress(session)) {
            return
        }

        const name = getSessionName(session)
        const pending = getFirstPendingRequest(session)
        const request = pending?.request
        const inputNotification = composeInputRequestNotification(session, pending)
        const toolName = request?.tool ? ` (${request.tool})` : ''
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send(
            this.sendKey,
            inputNotification ? `HAPI ${inputNotification.title}` : 'HAPI Permission Request',
            `${inputNotification?.body ?? `${name}${toolName}`}\n\n${url}`
        )
    }

    async sendSessionCompletion(session: Session, _reason: SessionEndReason): Promise<void> {
        if (!this.sendKey || this.shouldSuppress(session)) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send(this.sendKey, 'HAPI Session completed', `${agentName} · ${name}\n\n会话已结束。\n\n${url}`)
    }

    async sendSessionError(session: Session, _reason: SessionEndReason): Promise<void> {
        const destination = this.errorDestinations.get(session.namespace)
        if (!destination || shouldSuppressBackgroundNotification(session, this.visibilityTracker, destination.backgroundOnly)) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send(destination.sendKey, 'HAPI Session error', `${agentName} · ${name}\n\n会话异常结束。\n\n${url}`)
    }

    private async send(sendKey: string, title: string, desp: string): Promise<void> {
        const url = `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`
        const body = new URLSearchParams({
            title,
            desp
        })

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded'
            },
            body
        })

        if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new Error(`Server酱发送失败: HTTP ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`)
        }
    }

    private shouldSuppress(session: Session): boolean {
        return shouldSuppressBackgroundNotification(session, this.visibilityTracker, this.backgroundOnly)
    }
}
