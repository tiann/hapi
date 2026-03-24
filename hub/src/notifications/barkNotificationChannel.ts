import type { Session } from '../sync/syncEngine'
import type { NotificationChannel } from './notificationTypes'
import { BarkDelivery } from './barkDelivery'
import type { BarkAttentionPayload, BarkFetch } from './barkDelivery'
import { getAgentName, getSessionName } from './sessionInfo'

export type BarkNotificationSender = {
    send: (payload: BarkAttentionPayload) => Promise<void>
}

export class BarkNotificationChannel implements NotificationChannel {
    constructor(
        private readonly sender: BarkNotificationSender,
        private readonly publicUrl: string
    ) {}

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests)[0]
            : null
        const toolName = request?.tool ? ` (${request.tool})` : ''

        await this.sender.send({
            title: 'Permission Request',
            body: `${name}${toolName}`,
            group: `permission-${session.id}`,
            url: this.buildSessionUrl(session.id)
        })
    }

    async sendReady(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)

        await this.sender.send({
            title: 'Ready for input',
            body: `${agentName} is waiting in ${name}`,
            group: `ready-${session.id}`,
            url: this.buildSessionUrl(session.id)
        })
    }

    private buildSessionUrl(sessionId: string): string {
        try {
            const normalizedBase = `${this.publicUrl.replace(/\/+$/, '')}/`
            return new URL(`sessions/${sessionId}`, normalizedBase).toString()
        } catch {
            return `${this.publicUrl.replace(/\/+$/, '')}/sessions/${sessionId}`
        }
    }
}

type CreateBarkChannelOptions = {
    deviceKey: string | null
    serverUrl: string
    publicUrl: string
    fetchImpl?: BarkFetch
    timeoutMs?: number
}

export function createBarkNotificationChannel(
    options: CreateBarkChannelOptions
): BarkNotificationChannel | null {
    const deviceKey = options.deviceKey?.trim() ?? ''
    if (!deviceKey) {
        return null
    }

    const delivery = new BarkDelivery({
        baseUrl: options.serverUrl,
        deviceKey,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs
    })

    return new BarkNotificationChannel(delivery, options.publicUrl)
}
