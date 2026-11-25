import type { SessionEndReason } from '@hapi/protocol'
import type { QqBotOptions } from '../config/qqBotSettings'
import { getFirstPendingRequest, isInputRequestTool } from '../notifications/inputRequest'
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

    async sendReady(session: Session): Promise<void> {
        if (session.active) await this.send(session, 'HAPI Ready for input')
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) return
        const pending = getFirstPendingRequest(session)
        if (!pending) return
        const title = isInputRequestTool(pending.request.tool)
            ? `HAPI: ${getAgentName(session)} needs your input`
            : 'HAPI Permission Request'
        await this.send(session, title, () => {
            const current = this.getSession(session.id)
            const requests = current?.agentState?.requests
            return Boolean(current?.active && requests && this.isInScope(current)
                && Object.hasOwn(requests, pending.requestId))
        })
    }

    async sendSessionCompletion(session: Session, reason: SessionEndReason): Promise<void> {
        if (reason === 'completed') await this.send(session, 'HAPI Session completed')
    }

    private isInScope(session: Session): boolean {
        return session.namespace === this.options.namespace
            && (!this.options.backgroundOnly || !this.visibilityTracker.hasVisibleConnection(session.namespace))
    }

    private async send(session: Session, title: string, shouldSend?: () => boolean): Promise<void> {
        if (!this.isInScope(session)) return

        const id = encodeURIComponent(session.id).replace(/[()]/g, char => char === '(' ? '%28' : '%29')
        // Imported names and generated summaries can contain conversation text.
        const content = `**${title}**\n\nSession: ${session.id.slice(0, 8)}\n\n[Open HAPI session](${this.origin}/sessions/${id})`
        await this.client.sendMarkdown(content, shouldSend)
    }
}
