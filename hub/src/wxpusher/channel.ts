import type { WxPusherDestination } from '../config/notificationDestinations'
import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import type { NotificationChannel } from '../notifications/notificationTypes'
import { shouldSuppressBackgroundNotification } from '../notifications/backgroundOnly'
import { buildSessionUrl, getAgentName, getSessionName } from '../notifications/sessionInfo'
import { DEFAULT_NAMESPACE } from '../utils/accessToken'
import type { VisibilityTracker } from '../visibility/visibilityTracker'

export const WXPUSHER_SEND_URL = 'https://wxpusher.zjiecode.com/api/send/message'
export const WXPUSHER_REQUEST_TIMEOUT_MS = 10_000

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

export class WxPusherChannel implements NotificationChannel {
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

    async sendReady(_session: Session): Promise<void> {}

    async sendPermissionRequest(_session: Session): Promise<void> {}

    async sendSessionCompletion(session: Session, _reason: SessionEndReason): Promise<void> {
        if (session.namespace !== this.namespace
            || shouldSuppressBackgroundNotification(session, this.visibilityTracker, this.backgroundOnly)) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const url = buildSessionUrl(this.publicUrl, session.id)
        await this.send({
            appToken: this.appToken,
            content: `${agentName} · ${name}\n\n会话已结束。\n\n${url}`,
            summary: 'HAPI Session completed',
            contentType: 1,
            ...(this.uids.length > 0 ? { uids: this.uids } : {}),
            ...(this.topicIds.length > 0 ? { topicIds: this.topicIds } : {}),
            url,
        })
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
