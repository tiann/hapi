import type { Store } from '../store'
import { getFcmAccessToken, FCM_REQUEST_TIMEOUT_MS, type ServiceAccount } from './fcmAuth'

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
    /**
     * Rolling window of the last N send outcomes. Drives `isHealthy()`,
     * which the native-fallback probe consults to decide whether suppressing
     * web-push for this namespace is still safe. We deliberately do NOT
     * count `invalid` here - an invalid token is a per-device fact, not an
     * FCM-pipeline-broken signal (FCM was reachable, it just rejected one
     * stale token). Only `sent` and `failed` populate the buffer.
     */
    private recentOutcomes: Array<'sent' | 'failed'> = []
    private static readonly HEALTH_WINDOW = 8
    private static readonly HEALTH_FAILURE_THRESHOLD = 5

    constructor(
        private readonly projectId: string,
        private readonly serviceAccount: ServiceAccount,
        private readonly store: Store
    ) {}

    /**
     * Health gate for the native-fallback probe. Returns true only when the
     * recent-outcome window contains at least one positive datapoint AND
     * failures have not stacked past the threshold. When unhealthy, the
     * probe lets web-push fire as a last-resort surface for this namespace.
     *
     * "Needs positive evidence" semantics intentionally: an empty buffer
     * (cold-start) and a buffer dominated by failures-only both render
     * unhealthy. This closes the silent-blackhole window where a hub with
     * broken Firebase credentials would suppress web-push for the first N
     * events while waiting for failures to accumulate past the threshold.
     *
     * Trade-off: one duplicated notification per hub restart per namespace
     * (web-push + FCM both fire on event #1; FCM success records `sent` and
     * the gate engages from event #2 onward). Worth it for guaranteed
     * delivery on cold start.
     *
     * Addresses HAPI Bot Major review on PR #803.
     */
    isHealthy(): boolean {
        const successes = this.recentOutcomes.filter((o) => o === 'sent').length
        if (successes === 0) return false
        const failures = this.recentOutcomes.filter((o) => o === 'failed').length
        return failures < FcmService.HEALTH_FAILURE_THRESHOLD
    }

    private recordOutcome(outcome: 'sent' | 'failed'): void {
        this.recentOutcomes.push(outcome)
        if (this.recentOutcomes.length > FcmService.HEALTH_WINDOW) {
            this.recentOutcomes.shift()
        }
    }

    async sendToNamespace(namespace: string, payload: FcmSendPayload): Promise<FcmSendResult> {
        const devices = this.store.fcm.getDevicesByNamespace(namespace)
        if (devices.length === 0) {
            return { sent: 0, failed: 0, invalidTokens: [] }
        }

        let accessToken: string
        try {
            accessToken = await getFcmAccessToken(this.serviceAccount)
        } catch (e) {
            // Token-fetch failure (expired service account key, OAuth
            // outage, network) - count one health-failure (not one per
            // device, that would over-weight the buffer) and return.
            console.error('[FcmService] Token fetch failed:', e instanceof Error ? e.message : e)
            this.recordOutcome('failed')
            return { sent: 0, failed: devices.length, invalidTokens: [] }
        }

        const invalidTokens: string[] = []
        let sent = 0
        let failed = 0

        await Promise.all(devices.map(async (device) => {
            const result = await this.sendToToken(accessToken, device.token, payload, device.platform)
            // `invalid` is a per-device fact, not a pipeline signal -
            // exclude it from the health buffer (see field doc above).
            if (result === 'sent') {
                this.recordOutcome('sent')
            } else if (result === 'failed') {
                this.recordOutcome('failed')
            }
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
                body: JSON.stringify({ message }),
                signal: AbortSignal.timeout(FCM_REQUEST_TIMEOUT_MS)
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
        const invalid = this.isInvalidFcmTokenResponse(response.status, body)
        if (!invalid) {
            console.error('[FcmService] Send failed (transient):', response.status, body.slice(0, 200))
        }
        return invalid ? 'invalid' : 'failed'
    }

    /**
     * Parse FCM v1 error JSON and decide whether the token itself is dead.
     * Generic 404/NOT_FOUND (bad project id, missing resource) must not
     * unregister live devices — only explicit UNREGISTERED or token-field
     * INVALID_ARGUMENT qualifies.
     */
    private isInvalidFcmTokenResponse(status: number, body: string): boolean {
        const parsedError = ((): {
            error?: {
                status?: string
                details?: Array<{ fieldViolations?: Array<{ field?: string }> }>
            }
        } | null => {
            try {
                return JSON.parse(body) as {
                    error?: {
                        status?: string
                        details?: Array<{ fieldViolations?: Array<{ field?: string }> }>
                    }
                }
            } catch {
                return null
            }
        })()

        const errorStatus = parsedError?.error?.status ?? ''
        const tokenFieldViolation = parsedError?.error?.details?.some((detail) =>
            detail.fieldViolations?.some((violation) =>
                /message\.token|token/i.test(violation.field ?? '')
            )
        ) ?? false

        const isUnregistered = status === 404 && errorStatus === 'UNREGISTERED'
        const isMalformedToken = status === 400
            && errorStatus === 'INVALID_ARGUMENT'
            && tokenFieldViolation

        return isUnregistered || isMalformedToken
    }
}
