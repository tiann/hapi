/**
 * APNs client for the HAPI push relay: ES256 provider-token auth (jose) plus
 * a persistent HTTP/2 connection (node:http2).
 *
 * NOTE - deliberate duplication: hub/src/apns/ (work package P1) carries the
 * hub's own APNs JWT + HTTP/2 client for hubs that self-configure an APNs
 * key. The two copies are kept separate on purpose so the relay stays a
 * standalone, dependency-light deployable that never imports hub code. If
 * you fix a protocol bug here, check the twin in hub/src/apns/.
 *
 * Bun compatibility: verified on Bun 1.3.14 - Bun's node:http2 client talks
 * to a real node:http2 server (the tests in apns.test.ts exercise exactly
 * that against a local mock). The transport is still hidden behind the
 * `ApnsClient` interface so it can be swapped if a future Bun regresses,
 * and so route-level tests can inject a fake.
 */
import {
    connect,
    constants,
    type ClientHttp2Session,
    type ClientHttp2Stream,
    type OutgoingHttpHeaders
} from 'node:http2'
import { importPKCS8, SignJWT } from 'jose'

/**
 * Apple accepts provider tokens up to 60 minutes old and asks that they not
 * be refreshed more often than every 20 minutes. We reuse a token for
 * 45 minutes and mint a fresh one afterwards.
 */
export const APNS_JWT_MAX_AGE_MS = 45 * 60 * 1000

type ApnsSigningKey = Awaited<ReturnType<typeof importPKCS8>>

export type ApnsJwtProviderOptions = {
    /** Contents of the .p8 auth key (PKCS#8 PEM) - the file contents, not the path. */
    privateKeyPem: string
    /** APNs key id; goes into the JWT `kid` header. */
    keyId: string
    /** Apple developer team id; goes into the JWT `iss` claim. */
    teamId: string
    /** Injectable clock (milliseconds) for tests. Defaults to Date.now. */
    now?: () => number
}

export class ApnsJwtProvider {
    private cached: { token: string; issuedAtMs: number } | undefined
    private keyPromise: Promise<ApnsSigningKey> | undefined

    constructor(private readonly options: ApnsJwtProviderOptions) {}

    async getToken(): Promise<string> {
        const nowMs = this.options.now?.() ?? Date.now()
        if (this.cached !== undefined && nowMs - this.cached.issuedAtMs <= APNS_JWT_MAX_AGE_MS) {
            return this.cached.token
        }
        const key = await this.getKey()
        const token = await new SignJWT({})
            .setProtectedHeader({ alg: 'ES256', kid: this.options.keyId })
            .setIssuer(this.options.teamId)
            .setIssuedAt(Math.floor(nowMs / 1000))
            .sign(key)
        this.cached = { token, issuedAtMs: nowMs }
        return token
    }

    /** Drop the cached token so the next getToken() mints a fresh one. */
    invalidate(): void {
        this.cached = undefined
    }

    private getKey(): Promise<ApnsSigningKey> {
        if (this.keyPromise === undefined) {
            this.keyPromise = importPKCS8(this.options.privateKeyPem, 'ES256')
        }
        return this.keyPromise
    }
}

/** APNs caps `apns-collapse-id` at 64 bytes. */
export const APNS_COLLAPSE_ID_MAX_BYTES = 64

/**
 * Truncate a collapse id to 64 UTF-8 bytes without splitting a code point.
 */
export function truncateCollapseId(collapseId: string): string {
    const encoder = new TextEncoder()
    if (encoder.encode(collapseId).byteLength <= APNS_COLLAPSE_ID_MAX_BYTES) {
        return collapseId
    }
    let result = ''
    let bytes = 0
    for (const ch of collapseId) {
        const chBytes = encoder.encode(ch).byteLength
        if (bytes + chBytes > APNS_COLLAPSE_ID_MAX_BYTES) {
            break
        }
        result += ch
        bytes += chBytes
    }
    return result
}

/**
 * The exact APNs JSON body the relay sends. The alert is a fixed, generic
 * placeholder ("HAPI" / "New activity"): the real content travels only inside
 * `hapi.e` as AES-256-GCM ciphertext, and the device's Notification Service
 * Extension (`mutable-content: 1`) decrypts and rewrites the alert locally.
 * Must match what the iOS NSE and the hub-side client (P1) expect.
 */
export function buildApnsPayload(envelope: string): string {
    return JSON.stringify({
        aps: {
            'mutable-content': 1,
            alert: { title: 'HAPI', body: 'New activity' },
            sound: 'default'
        },
        hapi: { v: 1, e: envelope }
    })
}

export type ApnsPushRequest = {
    /** Hex APNs device token (already validated + lowercased by the caller). */
    deviceToken: string
    /** Full JSON payload string (see buildApnsPayload). */
    payload: string
    /** Optional collapse id; truncated to 64 bytes before hitting the wire. */
    collapseId?: string
    /** APNs priority; the route layer defaults this to 10. */
    priority: number
}

export type ApnsPushResult =
    | { kind: 'delivered'; apnsId?: string }
    /** APNs answered with a non-2xx status. `reason` is Apple's reason string. */
    | { kind: 'rejected'; status: number; reason: string }
    /** Could not get an answer at all (connect/write/timeout/JWT failure). */
    | { kind: 'transport-error'; message: string }

export interface ApnsClient {
    push(request: ApnsPushRequest): Promise<ApnsPushResult>
    close(): Promise<void>
}

export type Http2ApnsClientOptions = {
    /** e.g. https://api.push.apple.com - or a local mock server in tests. */
    baseUrl: string
    /** Bundle id, sent as `apns-topic`. */
    topic: string
    jwtProvider: ApnsJwtProvider
    requestTimeoutMs?: number
    connectTimeoutMs?: number
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

function parseRejectionReason(body: string, status: number): string {
    try {
        const parsed = JSON.parse(body) as { reason?: unknown }
        if (typeof parsed.reason === 'string' && parsed.reason.length > 0) {
            return parsed.reason
        }
    } catch {
        // fall through
    }
    return `HTTP ${status}`
}

/**
 * node:http2 client that keeps a single session to APNs open and reconnects
 * lazily whenever the previous one died (GOAWAY, network drop, idle close).
 */
export class Http2ApnsClient implements ApnsClient {
    private readonly baseUrl: string
    private readonly topic: string
    private readonly jwtProvider: ApnsJwtProvider
    private readonly requestTimeoutMs: number
    private readonly connectTimeoutMs: number
    private sessionPromise: Promise<ClientHttp2Session> | undefined

    constructor(options: Http2ApnsClientOptions) {
        this.baseUrl = options.baseUrl
        this.topic = options.topic
        this.jwtProvider = options.jwtProvider
        this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
        this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000
    }

    async push(request: ApnsPushRequest): Promise<ApnsPushResult> {
        const first = await this.pushOnce(request)
        if (first.kind === 'rejected' && first.reason === 'ExpiredProviderToken') {
            // Our JWTs refresh at 45 min, inside Apple's 60-min cap, so this
            // only happens on clock skew. Mint a fresh token and retry once.
            this.jwtProvider.invalidate()
            return this.pushOnce(request)
        }
        return first
    }

    async close(): Promise<void> {
        const pending = this.sessionPromise
        this.sessionPromise = undefined
        if (pending === undefined) {
            return
        }
        try {
            const session = await pending
            session.destroy()
        } catch {
            // session never came up - nothing to tear down
        }
    }

    private async pushOnce(request: ApnsPushRequest): Promise<ApnsPushResult> {
        let jwt: string
        try {
            jwt = await this.jwtProvider.getToken()
        } catch (err) {
            return { kind: 'transport-error', message: `APNs JWT signing failed: ${errorMessage(err)}` }
        }

        let session: ClientHttp2Session
        try {
            session = await this.ensureSession()
        } catch (err) {
            return { kind: 'transport-error', message: `APNs connect failed: ${errorMessage(err)}` }
        }

        const headers: OutgoingHttpHeaders = {
            ':method': 'POST',
            ':path': `/3/device/${request.deviceToken}`,
            'authorization': `bearer ${jwt}`,
            'apns-topic': this.topic,
            'apns-push-type': 'alert',
            'apns-priority': String(request.priority),
            'apns-expiration': '0',
            'content-type': 'application/json'
        }
        if (request.collapseId !== undefined) {
            const collapseId = truncateCollapseId(request.collapseId)
            if (collapseId.length > 0) {
                headers['apns-collapse-id'] = collapseId
            }
        }

        return await new Promise<ApnsPushResult>((resolve) => {
            let settled = false
            let timer: ReturnType<typeof setTimeout> | undefined
            const settle = (result: ApnsPushResult): void => {
                if (settled) {
                    return
                }
                settled = true
                if (timer !== undefined) {
                    clearTimeout(timer)
                }
                resolve(result)
            }

            let stream: ClientHttp2Stream
            try {
                stream = session.request(headers)
            } catch (err) {
                settle({ kind: 'transport-error', message: `APNs request failed: ${errorMessage(err)}` })
                return
            }

            timer = setTimeout(() => {
                try {
                    stream.close(constants.NGHTTP2_CANCEL)
                } catch {
                    // already gone
                }
                settle({
                    kind: 'transport-error',
                    message: `APNs request timed out after ${this.requestTimeoutMs}ms`
                })
            }, this.requestTimeoutMs)

            let status = 0
            let apnsId: string | undefined
            let body = ''
            stream.setEncoding('utf8')
            stream.on('response', (responseHeaders) => {
                status = Number(responseHeaders[':status'] ?? 0)
                const id = responseHeaders['apns-id']
                if (typeof id === 'string') {
                    apnsId = id
                }
            })
            stream.on('data', (chunk: string) => {
                // APNs error bodies are tiny JSON documents; cap defensively.
                if (body.length < 4096) {
                    body += chunk
                }
            })
            stream.on('error', (err: Error) => {
                settle({ kind: 'transport-error', message: `APNs stream error: ${err.message}` })
            })
            stream.on('end', () => {
                if (status >= 200 && status < 300) {
                    settle({ kind: 'delivered', apnsId })
                } else if (status === 0) {
                    // Stream ended without ever seeing response headers
                    // (server reset / connection died) - not a real rejection.
                    settle({ kind: 'transport-error', message: 'APNs stream ended before a response' })
                } else {
                    settle({ kind: 'rejected', status, reason: parseRejectionReason(body, status) })
                }
            })
            stream.on('close', () => {
                // Stream reset without a response (e.g. session died mid-flight).
                settle({ kind: 'transport-error', message: 'APNs stream closed before a response' })
            })
            stream.end(request.payload)
        })
    }

    private ensureSession(): Promise<ClientHttp2Session> {
        const cached = this.sessionPromise
        if (cached !== undefined) {
            return cached.then((session) => {
                if (session.destroyed || session.closed) {
                    if (this.sessionPromise === cached) {
                        this.sessionPromise = undefined
                    }
                    return this.ensureSession()
                }
                return session
            })
        }
        const fresh = this.connectSession()
        this.sessionPromise = fresh
        fresh.catch(() => {
            if (this.sessionPromise === fresh) {
                this.sessionPromise = undefined
            }
        })
        return fresh
    }

    private connectSession(): Promise<ClientHttp2Session> {
        const promise = new Promise<ClientHttp2Session>((resolve, reject) => {
            const session = connect(this.baseUrl)
            const drop = (): void => {
                if (this.sessionPromise === promise) {
                    this.sessionPromise = undefined
                }
            }
            let settled = false
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true
                    drop()
                    try {
                        session.destroy()
                    } catch {
                        // ignore
                    }
                    reject(new Error(`connect timeout after ${this.connectTimeoutMs}ms`))
                }
            }, this.connectTimeoutMs)
            session.once('connect', () => {
                if (!settled) {
                    settled = true
                    clearTimeout(timer)
                    resolve(session)
                }
            })
            session.on('error', (err: Error) => {
                drop()
                if (!settled) {
                    settled = true
                    clearTimeout(timer)
                    reject(err)
                }
            })
            session.on('close', () => {
                drop()
            })
        })
        return promise
    }
}
