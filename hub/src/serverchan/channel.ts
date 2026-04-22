import type { Session } from '../sync/syncEngine'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'

function buildSessionUrl(baseUrl: string, sessionId: string): string {
    try {
        return new URL(`/sessions/${sessionId}`, baseUrl).toString()
    } catch {
        const normalized = baseUrl.replace(/\/+$/, '')
        return `${normalized}/sessions/${sessionId}`
    }
}

export class ServerChanChannel implements NotificationChannel {
    constructor(
        private readonly sendKey: string,
        private readonly publicUrl: string
    ) {}

    async sendReady(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send('HAPI Ready for input', `${agentName} 正在等待输入\n\n会话：${name}\n\n${url}`)
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests)[0]
            : null
        const toolName = request?.tool ? ` (${request.tool})` : ''
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send('HAPI Permission Request', `${name}${toolName}\n\n${url}`)
    }

    async sendTaskNotification(session: Session, notification: TaskNotification): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const status = notification.status?.trim().toLowerCase()
        const title = status === 'failed' || status === 'error' || status === 'killed' || status === 'aborted'
            ? 'HAPI Task failed'
            : 'HAPI Task completed'
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send(title, `${agentName} · ${name}\n\n${notification.summary}\n\n${url}`)
    }

    private async send(title: string, desp: string): Promise<void> {
        const url = `https://sctapi.ftqq.com/${this.sendKey}.send`
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
}
