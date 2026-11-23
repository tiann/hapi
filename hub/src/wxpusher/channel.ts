import type { NotificationSendContext } from '../notifications/notificationSendContext'
import type { WxPusherDestination } from '../config/notificationDestinations'
import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import type { NotificationChannel } from '../notifications/notificationTypes'
import { shouldSuppressBackgroundNotification } from '../notifications/backgroundOnly'
import { buildSessionUrl, getAgentName, getSessionName } from '../notifications/sessionInfo'
import { composeInputRequestNotification, getFirstPendingRequest } from '../notifications/inputRequest'
import { DEFAULT_NAMESPACE } from '../utils/accessToken'
import type { VisibilityTracker } from '../visibility/visibilityTracker'

export const WXPUSHER_SEND_URL = 'https://wxpusher.zjiecode.com/api/send/message'
export const WXPUSHER_REQUEST_TIMEOUT_MS = 10_000
export const WXPUSHER_SUMMARY_LIMIT = 100

const wxPusherGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

type WxPusherResponse = {
    code?: number
    msg?: string
    message?: string
    data?: unknown
}

export type WxPusherMessage = {
    appToken: string
    content: string
    summary: string
    contentType: 1
    uids?: string[]
    topicIds?: number[]
    url: string
}

function isWxPusherResponse(value: unknown): value is WxPusherResponse {
    return typeof value === 'object' && value !== null
}

function truncateWxPusherSummary(summary: string): string {
    if (Array.from(summary).length <= WXPUSHER_SUMMARY_LIMIT) {
        return summary
    }

    let result = ''
    let length = 0
    for (const { segment } of wxPusherGraphemes.segment(summary)) {
        const segmentLength = Array.from(segment).length
        if (length + segmentLength > WXPUSHER_SUMMARY_LIMIT - 1) {
            break
        }
        result += segment
        length += segmentLength
    }

    return `${result.trimEnd()}…`
}

export class WxPusherChannel implements NotificationChannel {
    readonly independent = true

    constructor(
        private readonly appToken: string,
        private readonly uids: string[],
        private readonly topicIds: number[],
        private readonly publicUrl: string,
        private readonly visibilityTracker: VisibilityTracker | null = null,
        private readonly backgroundOnly = false,
        private readonly requestTimeoutMs = WXPUSHER_REQUEST_TIMEOUT_MS,
        private readonly namespace = DEFAULT_NAMESPACE
    ) {}

    async sendReady(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active || ctx?.readyReason === 'reactive-polling-paused' || this.shouldSuppress(session)) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send(this.createMessage(
            `就绪：${name}`,
            `${agentName} 正在等待输入\n\n会话：${name}`,
            url
        ))
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active || this.shouldSuppress(session)) {
            return
        }

        const name = getSessionName(session)
        const pending = getFirstPendingRequest(session)
        if (!pending) return
        const inputNotification = composeInputRequestNotification(session, pending)
        const url = buildSessionUrl(this.publicUrl, session.id)
        const content = inputNotification
            ? `${inputNotification.title}\n\n${inputNotification.body}\n会话：${name}`
            : `${getAgentName(session)} · ${name} (${pending.request.tool})`
        await this.send(this.createMessage(
            `${inputNotification ? '待输入' : '授权'}：${name}`,
            content,
            url
        ))
    }

    async sendSessionCompletion(session: Session, _reason: SessionEndReason): Promise<void> {
        if (this.shouldSuppress(session)) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send(this.createMessage(`完成：${name}`, `${agentName} · ${name}\n\n会话已结束。`, url))
    }

    async sendSessionError(session: Session, _reason: SessionEndReason): Promise<void> {
        if (this.shouldSuppress(session)) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send(this.createMessage(`异常：${name}`, `${agentName} · ${name}\n\n会话异常结束。`, url))
    }

    private shouldSuppress(session: Session): boolean {
        return session.namespace !== this.namespace
            || shouldSuppressBackgroundNotification(session, this.visibilityTracker, this.backgroundOnly)
    }

    private createMessage(summary: string, content: string, url: string): WxPusherMessage {
        return {
            appToken: this.appToken,
            content: `${content}\n\n${url}`,
            summary: truncateWxPusherSummary(summary),
            contentType: 1,
            ...(this.uids.length > 0 ? { uids: this.uids } : {}),
            ...(this.topicIds.length > 0 ? { topicIds: this.topicIds } : {}),
            url,
        }
    }

    private async send(message: WxPusherMessage): Promise<void> {
        const response = await fetch(WXPUSHER_SEND_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify(message),
            signal: AbortSignal.timeout(this.requestTimeoutMs),
        })

        const responseText = await response.text().catch(() => '')
        if (!response.ok) {
            throw new Error(
                `WxPusher send failed: HTTP ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ''}`
            )
        }

        let result: unknown = null
        if (responseText) {
            try {
                result = JSON.parse(responseText) as unknown
            } catch {
                throw new Error(`WxPusher send failed: invalid JSON response${responseText ? ` - ${responseText}` : ''}`)
            }
        }

        if (!isWxPusherResponse(result) || result.code !== 1000) {
            const message = isWxPusherResponse(result)
                ? result.msg ?? result.message
                : undefined
            throw new Error(`WxPusher send failed: ${(message ?? responseText) || 'unknown error'}`)
        }
        if (result.data !== undefined) {
            if (!Array.isArray(result.data)) throw new Error('WxPusher send failed: invalid recipient results')
            const rejected = result.data.filter(entry => !isWxPusherResponse(entry) || entry.code !== 1000).length
            if (rejected > 0) {
                // Do not log recipient identifiers or provider-supplied text, and do not
                // retry the batch: some recipients may already have an accepted task.
                throw new Error(`WxPusher send failed: ${rejected} of ${result.data.length} recipient tasks not accepted`)
            }
        }
    }
}

export function createWxPusherChannels(
    destinations: ReadonlyMap<string, WxPusherDestination>,
    publicUrl: string,
    visibilityTracker: VisibilityTracker | null
): WxPusherChannel[] {
    return Array.from(destinations, ([namespace, destination]) => new WxPusherChannel(
        destination.appToken,
        destination.uids,
        destination.topicIds,
        publicUrl,
        visibilityTracker,
        destination.backgroundOnly,
        WXPUSHER_REQUEST_TIMEOUT_MS,
        namespace
    ))
}
