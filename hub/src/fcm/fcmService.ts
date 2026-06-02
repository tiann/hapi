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
            const ok = await this.sendToToken(accessToken, device.token, payload, device.platform)
            if (ok) {
                sent += 1
                return
            }
            failed += 1
            invalidTokens.push(device.token)
            this.store.fcm.removeDeviceByToken(namespace, device.token)
        }))

        return { sent, failed, invalidTokens }
    }

    private async sendToToken(
        accessToken: string,
        token: string,
        payload: FcmSendPayload,
        platform: 'phone' | 'wear'
    ): Promise<boolean> {
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

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${accessToken}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({ message })
        })

        if (response.ok) {
            return true
        }

        const body = await response.text().catch(() => '')
        const invalid = response.status === 404
            || body.includes('UNREGISTERED')
            || body.includes('NOT_FOUND')
        if (!invalid) {
            console.error('[FcmService] Send failed:', response.status, body.slice(0, 200))
        }
        return false
    }
}
