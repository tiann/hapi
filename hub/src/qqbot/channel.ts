import type { SessionEndReason } from '@hapi/protocol'
import type { QqBotOptions } from '../config/qqBotSettings'
import { isInputRequestTool } from '../notifications/inputRequest'
import type { NotificationSendContext } from '../notifications/notificationSendContext'
import type { NotificationChannel } from '../notifications/notificationTypes'
import { getAgentName } from '../notifications/sessionInfo'
import type { Session } from '../sync/syncEngine'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import { QqBotClient, type QqBotFetch } from './client'

export class QqBotChannel implements NotificationChannel {
    private readonly client: QqBotClient
    private readonly origin: string

    constructor(
        private readonly options: QqBotOptions,
        publicUrl: string,
        private readonly visibilityTracker: VisibilityTracker,
        private readonly getSession: (id: string) => Session | null | undefined,
        fetcher?: QqBotFetch
    ) {
        this.client = new QqBotClient(options, fetcher)
        this.origin = new URL(publicUrl).origin
    }

    async sendReady(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) return
        const { thinking: wasThinking, activeTurnStartedAt: turnStartedAt } = ctx?.readyState ?? session
        await this.send(session, () => {
            const current = this.getSession(session.id)
            if (!current?.active || ctx?.readyState?.isSuperseded()) return null
            if (current.thinking && (!wasThinking || current.activeTurnStartedAt !== turnStartedAt)) return null
            return 'HAPI Ready for input'
        })
    }

    async sendPermissionRequest(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) return
        const requestIds = ctx?.permissionRequestIds ?? Object.keys(session.agentState?.requests ?? {})
        if (requestIds.length === 0) return
        await this.send(session, () => {
            const current = this.getSession(session.id)
            const requests = current?.agentState?.requests
            if (!current?.active || !requests) return null
            // A newly added request can get its own alert; this one covers the dispatch snapshot.
            let hasInput = false
            let hasApproval = false
            for (const id of requestIds) {
                if (!Object.hasOwn(requests, id)) continue
                const request = requests[id]
                if (!request) continue
                if (isInputRequestTool(request.tool)) hasInput = true
                else hasApproval = true
                if (hasInput && hasApproval) return 'HAPI Permission and Input Requests'
            }
            if (hasInput) return `HAPI: ${getAgentName(current)} needs your input`
            return hasApproval ? 'HAPI Permission Request' : null
        })
    }

    async sendSessionCompletion(session: Session, reason: SessionEndReason): Promise<void> {
        if (reason === 'completed') await this.send(session, () => 'HAPI Session completed')
    }

    private isInScope(session: Session): boolean {
        return session.namespace === this.options.namespace
            && (!this.options.backgroundOnly || !this.visibilityTracker.hasVisibleConnection(session.namespace))
    }

    private async send(session: Session, getTitle: () => string | null): Promise<void> {
        const id = encodeURIComponent(session.id).replace(/[()]/g, char => char === '(' ? '%28' : '%29')
        // Imported names and generated summaries can contain conversation text.
        const label = session.id.slice(0, 8)
        await this.client.sendMarkdown(() => {
            if (!this.isInScope(session)) return null
            const title = getTitle()
            if (title === null) return null
            return `**${title}**\n\nSession: ${label}\n\n[Open HAPI session](${this.origin}/sessions/${id})`
        })
    }
}
