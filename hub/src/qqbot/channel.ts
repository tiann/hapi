import type { SessionEndReason } from '@hapi/protocol'
import type { QqBotOptions } from '../config/qqBotSettings'
import { getFirstPendingRequest, isInputRequestTool } from '../notifications/inputRequest'
import type { NotificationChannel } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { Session } from '../sync/syncEngine'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import { QqBotClient, type QqBotFetch } from './client'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function escapeSessionName(name: string): string {
    const line = name.replace(/\s+/gu, ' ').trim()
    let preview = ''
    for (const { segment } of graphemes.segment(line)) {
        if (preview.length + segment.length > 160) {
            preview += '…'
            break
        }
        preview += segment
    }
    return preview.replace(/[\\`*_{}\[\]()<>#!|~]/g, '\\$&')
}

export class QqBotChannel implements NotificationChannel {
    private readonly client: QqBotClient
    private readonly origin: string

    constructor(
        private readonly options: QqBotOptions,
        publicUrl: string,
        private readonly visibilityTracker: VisibilityTracker,
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
        const title = pending && isInputRequestTool(pending.request.tool)
            ? `HAPI: ${getAgentName(session)} needs your input`
            : 'HAPI Permission Request'
        await this.send(session, title)
    }

    async sendSessionCompletion(session: Session, reason: SessionEndReason): Promise<void> {
        if (reason === 'completed') await this.send(session, 'HAPI Session completed')
    }

    private async send(session: Session, title: string): Promise<void> {
        if (session.namespace !== this.options.namespace
            || (this.options.backgroundOnly && this.visibilityTracker.hasVisibleConnection(session.namespace))) return

        const id = encodeURIComponent(session.id).replace(/[()]/g, char => char === '(' ? '%28' : '%29')
        const name = escapeSessionName(getSessionName(session))
        const content = `**${title}**\n\nSession: ${name}\n\n[Open HAPI session](${this.origin}/sessions/${id})`
        await this.client.sendMarkdown(content)
    }
}
