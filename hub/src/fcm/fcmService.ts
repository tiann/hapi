import type { Store } from '../store'
import { getFcmAccessToken, type ServiceAccount } from './fcmAuth'

export type FcmDataPayload = {
    type: string
    sessionId: string
    sessionName: string
    url: string
    requestId?: string
    title: string
    body: string
    contractVersion: string
    /**
     * Visual urgency hint for the client. Drives the notification accent
     * color on Wear OS / phone, and may be used for sound channel routing
     * later. Independent of `type` because `task-notification` is one
     * type that splits across success and failure outcomes.
     *
     *  - `info`     ready / ambient ('no action needed') -> blue
     *  - `success`  task completed                       -> green
     *  - `warning`  permission request                   -> amber
     *  - `error`    task failed / aborted                -> red
     */
    severity?: 'info' | 'success' | 'warning' | 'error'
    /**
     * JSON-stringified `AGENT_NOTIFY_SUMMARY` object when the agent emitted
     * one as the trailing line of its last message. The companion app may
     * use this for richer rendering or future event-bus routing; absent
     * when the agent did not emit a summary.
     */
    notifySummary?: string
}

export type FcmSendPayload = {
    title: string
    body: string
    tag?: string
    data: FcmDataPayload
}

type FcmSendResult = {
    sent: number
    failed: number
    invalidTokens: string[]
}

/**
 * Outcome of a single FCM send. We split `failed` into:
 *   - `invalid`: token is dead and will never succeed (uninstall, rotation,
 *     malformed). Safe to remove from the device registry.
 *   - `failed`:  transient or out-of-band error (rate limit, 5xx, auth
 *     glitch). MUST NOT be treated as token death - we'd silently
 *     unregister live devices on every Google blip.
 */
type FcmTokenSendResult = 'sent' | 'invalid' | 'failed'

export class FcmService {
    constructor(
        private readonly projectId: string,
        private readonly serviceAccount: ServiceAccount,
        private readonly store: Store
    ) {}

    async sendToNamespace(namespace: string, payload: FcmSendPayload): Promise<FcmSendResult> {
        const devices = this.store.fcm.getDevicesByNamespace(namespace)
        if (devices.length === 0) {
            return { sent: 0, failed: 0, invalidTokens: [] }
        }

        const accessToken = await getFcmAccessToken(this.serviceAccount)
        const invalidTokens: string[] = []
        let sent = 0
        let failed = 0

        await Promise.all(devices.map(async (device) => {
            const result = await this.sendToToken(accessToken, device.token, payload, device.platform)
            if (result === 'sent') {
                sent += 1
                return
            }
            failed += 1
            if (result === 'invalid') {
                invalidTokens.push(device.token)
                this.store.fcm.removeDeviceByToken(namespace, device.token)
            }
        }))

        return { sent, failed, invalidTokens }
    }

    private async sendToToken(
        accessToken: string,
        token: string,
        payload: FcmSendPayload,
        platform: 'phone' | 'wear'
    ): Promise<FcmTokenSendResult> {
        const url = `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`
        const dataRecord: Record<string, string> = {
            type: payload.data.type,
            sessionId: payload.data.sessionId,
            sessionName: payload.data.sessionName,
            url: payload.data.url,
            title: payload.data.title,
            body: payload.data.body,
            contractVersion: payload.data.contractVersion
        }
        if (payload.data.requestId) {
            dataRecord.requestId = payload.data.requestId
        }
        if (payload.data.severity) {
            dataRecord.severity = payload.data.severity
        }
        if (payload.data.notifySummary) {
            dataRecord.notifySummary = payload.data.notifySummary
        }

        // Data-only: if we also send `notification`, Android does not call
        // onMessageReceived while backgrounded — Wear relay never runs.
        const message: Record<string, unknown> = {
            token,
            data: dataRecord,
            android: {
                priority: 'HIGH'
            }
        }

        if (platform === 'wear') {
            message.android = {
                ...(message.android as Record<string, unknown>),
                direct_boot_ok: true
            }
        }

        let response: Response
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({ message })
            })
        } catch (e) {
            // Network error (DNS, TCP, TLS) - transient, never a token-death signal.
            console.error('[FcmService] Send threw:', e instanceof Error ? e.message : e)
            return 'failed'
        }

        if (response.ok) {
            return 'sent'
        }

        const body = await response.text().catch(() => '')
        // Per FCM v1 docs, only these signal a permanently-dead token:
        //   - HTTP 404 with UNREGISTERED      (app uninstalled / token rotated)
        //   - HTTP 404 with NOT_FOUND         (legacy alias)
        //   - HTTP 400 with INVALID_ARGUMENT against the `token` field
        //     (malformed; we conservatively only treat this as invalid when the
        //      body explicitly references the token field, otherwise we may be
        //      sending a malformed payload and would mis-blame the device).
        // Everything else - 401 auth, 403 permission, 429 quota, 5xx server -
        // is transient and devices stay registered.
        const isUnregistered = response.status === 404
            && (body.includes('UNREGISTERED') || body.includes('NOT_FOUND'))
        const isMalformedToken = response.status === 400
            && body.includes('INVALID_ARGUMENT')
            && /token/i.test(body)
        const invalid = isUnregistered || isMalformedToken
        if (!invalid) {
            console.error('[FcmService] Send failed (transient):', response.status, body.slice(0, 200))
        }
        return invalid ? 'invalid' : 'failed'
    }
}
