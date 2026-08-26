import http2 from 'node:http2'
import * as jose from 'jose'

import type { IosPushRequest, IosPushSendOutcome, IosPushTransport } from './transport'

export const APNS_PRODUCTION_HOST = 'https://api.push.apple.com'
export const APNS_SANDBOX_HOST = 'https://api.sandbox.push.apple.com'
export const APNS_REQUEST_TIMEOUT_MS = 10_000

/**
 * APNs provider-token JWTs must be reused across pushes and regenerated
 * before Apple's 60-minute hard cap. Apple also throttles keys that mint
 * tokens too often, so we refresh only once the cached token is older
 * than 45 minutes.
 */
export const APNS_JWT_MAX_AGE_MS = 45 * 60 * 1000

/**
 * Mints and caches the ES256 provider JWT for APNs.
 * Header: `{ alg: "ES256", kid: <keyId> }`; claims: `{ iss: <teamId>, iat }`.
 */
export class ApnsJwtProvider {
    private cached: { token: string; issuedAtMs: number } | null = null

    constructor(
        /** PKCS8 PEM contents of the .p8 APNs auth key. */
        private readonly keyP8: string,
        private readonly keyId: string,
        private readonly teamId: string
    ) {}

    async getToken(nowMs: number = Date.now()): Promise<string> {
        if (this.cached && nowMs - this.cached.issuedAtMs < APNS_JWT_MAX_AGE_MS) {
            return this.cached.token
        }
        const key = await jose.importPKCS8(this.keyP8, 'ES256')
        const token = await new jose.SignJWT({})
            .setProtectedHeader({ alg: 'ES256', kid: this.keyId })
            .setIssuer(this.teamId)
            .setIssuedAt(Math.floor(nowMs / 1000))
            .sign(key)
        this.cached = { token, issuedAtMs: nowMs }
        return token
    }
}

/**
 * APNs request body. The generic alert is the no-decrypt fallback: if the
 * device's Notification Service Extension cannot run (or decryption fails),
 * iOS still shows "HAPI / New activity" instead of leaking nothing at all.
 * `mutable-content: 1` is what invokes the extension so it can decrypt
 * `hapi.e` and replace title/body with the real content.
 */
export function buildApnsRequestBody(envelope: string): Record<string, unknown> {
    return {
        aps: {
            'mutable-content': 1,
            alert: { title: 'HAPI', body: 'New activity' },
            sound: 'default'
        },
        hapi: { v: 1, e: envelope }
    }
}

export type ApnsClientOptions = {
    /** PKCS8 PEM contents of the .p8 APNs auth key. */
    keyP8: string
    keyId: string
    teamId: string
    bundleId: string
    /** APNs authority, e.g. https://api.push.apple.com. Injectable for tests. */
    host: string
    requestTimeoutMs?: number
}

/**
 * Direct APNs transport over HTTP/2 via `node:http2`.
 *
 * TRANSPORT VERIFICATION: Bun's `node:http2` *client* is exercised for real
 * by apnsClient.test.ts, which spins up a local `node:http2` h2 server and
 * drives this exact class against it (verified working on Bun 1.3.14).
 *
 * One session per send: a dev-machine hub emits a handful of notifications
 * per minute at most, so connection reuse buys nothing and a persistent
 * APNs session would need ping/goaway lifecycle management.
 */
export class ApnsClient implements IosPushTransport {
    private readonly jwtProvider: ApnsJwtProvider
    private readonly bundleId: string
    private readonly host: string
    private readonly requestTimeoutMs: number

    constructor(options: ApnsClientOptions) {
        this.jwtProvider = new ApnsJwtProvider(options.keyP8, options.keyId, options.teamId)
        this.bundleId = options.bundleId
        this.host = options.host
        this.requestTimeoutMs = options.requestTimeoutMs ?? APNS_REQUEST_TIMEOUT_MS
    }

    async send(request: IosPushRequest): Promise<IosPushSendOutcome> {
        let jwt: string
        try {
            jwt = await this.jwtProvider.getToken()
        } catch (e) {
            // Broken .p8 key material is our problem, never the device's.
            console.error('[ApnsClient] JWT generation failed:', e instanceof Error ? e.message : e)
            return 'failed'
        }

        return await new Promise<IosPushSendOutcome>((resolve) => {
            let settled = false
            let client: http2.ClientHttp2Session
            const finish = (outcome: IosPushSendOutcome) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                try {
                    client.close()
                } catch {
                }
                resolve(outcome)
            }
            const timer = setTimeout(() => {
                console.error('[ApnsClient] Request timed out after', this.requestTimeoutMs, 'ms')
                try {
                    client.destroy()
                } catch {
                }
                finish('failed')
            }, this.requestTimeoutMs)

            try {
                client = http2.connect(this.host)
            } catch (e) {
                console.error('[ApnsClient] Connect threw:', e instanceof Error ? e.message : e)
                clearTimeout(timer)
                resolve('failed')
                return
            }
            client.on('error', (e) => {
                // Network error (DNS, TCP, TLS) - transient, never token death.
                console.error('[ApnsClient] Connection error:', e instanceof Error ? e.message : e)
                finish('failed')
            })

            const headers: Record<string, string> = {
                ':method': 'POST',
                ':path': `/3/device/${request.token}`,
                authorization: `bearer ${jwt}`,
                'apns-topic': this.bundleId,
                'apns-push-type': 'alert',
                'apns-priority': String(request.priority ?? 10),
                'apns-expiration': '0',
                'content-type': 'application/json'
            }
            if (request.collapseId) {
                headers['apns-collapse-id'] = request.collapseId
            }

            let req: http2.ClientHttp2Stream
            try {
                req = client.request(headers)
            } catch (e) {
                console.error('[ApnsClient] Request threw:', e instanceof Error ? e.message : e)
                finish('failed')
                return
            }
            req.on('error', (e) => {
                console.error('[ApnsClient] Stream error:', e instanceof Error ? e.message : e)
                finish('failed')
            })

            let status = 0
            const chunks: Buffer[] = []
            req.on('response', (responseHeaders) => {
                status = Number(responseHeaders[':status'] ?? 0)
            })
            req.on('data', (chunk: Buffer) => {
                chunks.push(chunk)
            })
            req.on('end', () => {
                finish(this.classifyResponse(status, Buffer.concat(chunks).toString('utf8')))
            })
            req.end(JSON.stringify(buildApnsRequestBody(request.envelope)))
        })
    }

    /**
     * APNs error contract: only explicit token death may prune the device
     * row - 410 (Unregistered) and 400 with reason BadDeviceToken. Any
     * other status (403 auth, 429 throttle, 5xx) is transient; unregistering
     * live devices on a blip would be the same bug FCM's handler guards
     * against.
     */
    private classifyResponse(status: number, body: string): IosPushSendOutcome {
        if (status >= 200 && status < 300) {
            return 'sent'
        }
        const reason = ((): string => {
            try {
                return (JSON.parse(body) as { reason?: string }).reason ?? ''
            } catch {
                return ''
            }
        })()
        if (status === 410) {
            return 'invalid'
        }
        if (status === 400 && reason === 'BadDeviceToken') {
            return 'invalid'
        }
        console.error('[ApnsClient] Send failed (transient):', status, reason || body.slice(0, 200))
        return 'failed'
    }
}
