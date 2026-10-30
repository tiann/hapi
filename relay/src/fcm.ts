/** Standalone FCM HTTP v1 sender. No notification plaintext enters this module. */
import { importPKCS8, SignJWT } from 'jose'

const OAUTH_URL = 'https://oauth2.googleapis.com/token'
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
export const FCM_REQUEST_TIMEOUT_MS = 10_000

export type FcmFetch = (url: string, init: RequestInit) => Promise<Response>

type ServiceAccount = { project_id: string; client_email: string; private_key: string }

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

export function parseServiceAccount(value: unknown): ServiceAccount {
    const data = record(value)
    if (!data || !['project_id', 'client_email', 'private_key'].every(key =>
        typeof data[key] === 'string' && data[key].trim().length > 0
    )) {
        throw new Error('FCM service account requires project_id, client_email and private_key')
    }
    return {
        project_id: data.project_id as string,
        client_email: data.client_email as string,
        private_key: data.private_key as string
    }
}

export class FcmAccessTokenProvider {
    private cached: { token: string; expiresAt: number } | null = null
    private pending: Promise<string> | null = null

    private constructor(
        private readonly email: string,
        private readonly key: CryptoKey,
        private readonly fetcher: FcmFetch,
        private readonly now: () => number,
        private readonly timeoutMs: number
    ) {}

    static async create(
        account: ServiceAccount,
        options: { fetcher?: FcmFetch; now?: () => number; timeoutMs?: number } = {}
    ): Promise<FcmAccessTokenProvider> {
        // Import at startup: a broken mounted key must fail readiness.
        const key = await importPKCS8(account.private_key, 'RS256')
        return new FcmAccessTokenProvider(
            account.client_email, key, options.fetcher ?? fetch,
            options.now ?? Date.now, options.timeoutMs ?? FCM_REQUEST_TIMEOUT_MS
        )
    }

    getAccessToken(): Promise<string> {
        if (this.cached && this.cached.expiresAt > this.now() + 60_000) {
            return Promise.resolve(this.cached.token)
        }
        if (!this.pending) {
            this.pending = this.exchange().finally(() => { this.pending = null })
        }
        return this.pending
    }

    invalidate(): void { this.cached = null }

    private async exchange(): Promise<string> {
        const issuedAt = this.now()
        const seconds = Math.floor(issuedAt / 1000)
        const assertion = await new SignJWT({ scope: FCM_SCOPE })
            .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
            .setIssuer(this.email).setSubject(this.email).setAudience(OAUTH_URL)
            .setIssuedAt(seconds).setExpirationTime(seconds + 3600).sign(this.key)
        const response = await this.fetcher(OAUTH_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
            signal: AbortSignal.timeout(this.timeoutMs)
        })
        if (!response.ok) throw new Error('FCM OAuth exchange failed')
        const data = record(await response.json())
        const token = data?.access_token
        const expires = data?.expires_in
        if (typeof token !== 'string' || !token || typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0) {
            throw new Error('Invalid FCM OAuth response')
        }
        this.cached = { token, expiresAt: issuedAt + Math.min(expires, 3600) * 1000 }
        return token
    }
}

export type FcmPushRequest = { token: string; envelope: string; priority: number }
export type FcmPushResult = {
    kind: 'delivered' | 'unregistered' | 'rate-limited' | 'upstream'
    status?: number
}
export interface FcmClient { push(request: FcmPushRequest): Promise<FcmPushResult> }

/** Payload/config errors are NOT evidence that a registration token is dead. */
export function isInvalidFcmToken(status: number, value: unknown): boolean {
    const error = record(record(value)?.error)
    const details = Array.isArray(error?.details) ? error.details.map(record) : []
    const fcmCode = details.find(detail =>
        detail?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError'
    )?.errorCode
    if (status === 404 && (fcmCode === 'UNREGISTERED' || error?.status === 'UNREGISTERED')) return true
    if (status !== 400 || error?.status !== 'INVALID_ARGUMENT') return false
    const violations = details.flatMap(detail => Array.isArray(detail?.fieldViolations)
        ? detail.fieldViolations.map(record) : [])
    if (violations.length) return violations.every(violation => violation?.field === 'message.token')
    // FcmError/INVALID_ARGUMENT alone can also describe payload errors.
    return fcmCode === 'INVALID_ARGUMENT' && typeof error?.message === 'string'
        && /^The registration token is not a valid FCM registration token\.?$/i.test(error.message)
}

export class HttpFcmClient implements FcmClient {
    constructor(
        private readonly projectId: string,
        private readonly packageName: string,
        private readonly auth: Pick<FcmAccessTokenProvider, 'getAccessToken' | 'invalidate'>,
        private readonly fetcher: FcmFetch = fetch,
        private readonly timeoutMs: number = FCM_REQUEST_TIMEOUT_MS
    ) {}

    async push(request: FcmPushRequest): Promise<FcmPushResult> {
        try {
            const accessToken = await this.auth.getAccessToken()
            const response = await this.fetcher(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`, {
                method: 'POST',
                headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
                body: JSON.stringify({ message: {
                    token: request.token,
                    data: { hapi_v: '1', hapi_e: request.envelope },
                    android: {
                        priority: request.priority === 5 ? 'NORMAL' : 'HIGH',
                        restricted_package_name: this.packageName
                    }
                } }),
                signal: AbortSignal.timeout(this.timeoutMs)
            })
            if (response.ok) return { kind: 'delivered' }
            if (response.status === 429) return { kind: 'rate-limited', status: 429 }
            if (response.status === 401) this.auth.invalidate()
            const body: unknown = await response.json().catch(() => null)
            return {
                kind: isInvalidFcmToken(response.status, body) ? 'unregistered' : 'upstream',
                status: response.status
            }
        } catch {
            // Provider errors may echo tokens/credentials. Return only a classification.
            return { kind: 'upstream' }
        }
    }
}
