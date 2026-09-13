/**
 * HAPI push relay - a tiny standalone service that forwards E2E-encrypted
 * push envelopes from self-hosted hubs to APNs and FCM.
 *
 * Privacy stance: the relay never sees notification content. Hubs encrypt
 * the payload with a per-device AES-256-GCM key known only to hub + device;
 * this service forwards the opaque `envelope` bytes to APNs or FCM, and the
 * app decrypts locally. Envelopes are never logged - log lines carry only
 * the platform, hashed token prefix, outcome and duration.
 *
 * Trust model: no client auth by design. Possession of a device token is the
 * capability (the same model FCM uses - cf. hub/src/fcm/fcmService.ts where
 * any hub with credentials can push to any token it knows). Mitigations:
 * per-token and per-IP token buckets, an envelope size cap, and a small
 * request body limit. See relay/README.md.
 */
import { createHash } from 'node:crypto'
import {
    ApnsJwtProvider,
    Http2ApnsClient,
    buildApnsPayload,
    type ApnsClient,
    type ApnsPushResult
} from './apns'
import {
    APNS_HOSTS,
    IP_RATE_LIMIT,
    MAX_ENVELOPE_BYTES,
    TOKEN_RATE_LIMIT,
    loadConfigFromEnv,
    readRelayVersion,
    type RelayConfig
} from './config'
import { TokenBucketLimiter } from './rateLimit'
import { FcmAccessTokenProvider, HttpFcmClient, parseServiceAccount, type FcmClient, type FcmPushResult } from './fcm'

export const SERVICE_NAME = 'hapi-push-relay'

/** Hard cap on the request body accepted by Bun.serve (defense in depth). */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024

const HEX_TOKEN_RE = /^[0-9a-fA-F]+$/
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

export type RelayAppDeps = {
    apns?: ApnsClient
    fcm?: FcmClient
    version: string
    tokenLimiter: TokenBucketLimiter
    ipLimiter: TokenBucketLimiter
    /** Injectable log sink for tests. Defaults to console.log. */
    log?: (line: string) => void
}

export type RelayApp = {
    /**
     * Handle one HTTP request. `clientIp` is resolved by the server wrapper
     * (socket address, or x-forwarded-for when RELAY_TRUST_PROXY is set);
     * null falls back to a shared "unknown" rate-limit bucket.
     */
    handle: (req: Request, clientIp: string | null) => Promise<Response>
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })
}

function pushError(status: number, code: string, message?: string): Response {
    return json(status, message === undefined ? { ok: false, code } : { ok: false, code, message })
}

/**
 * Privacy-preserving token reference for logs: a short hash prefix, never
 * the token itself (a device token is a push capability).
 */
export function hashedTokenPrefix(token: string, platform: 'ios' | 'android'): string {
    const normalized = platform === 'ios' ? token.toLowerCase() : token
    return createHash('sha256').update(`${platform}:${normalized}`).digest('hex').slice(0, 12)
}

type ValidPushRequest = {
    platform: 'ios' | 'android'
    token: string
    envelope: string
    collapseId?: string
    priority: number
}

type ValidationOutcome =
    | { valid: true; request: ValidPushRequest }
    | { valid: false; response: Response }

function validatePushBody(parsed: unknown): ValidationOutcome {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { valid: false, response: pushError(400, 'bad_request', 'body must be a JSON object') }
    }
    const body = parsed as Record<string, unknown>

    if (body.platform !== 'ios' && body.platform !== 'android') {
        return { valid: false, response: pushError(400, 'bad_request', 'platform must be "ios" or "android"') }
    }

    const token = body.token
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) {
        return { valid: false, response: pushError(400, 'bad_request', 'token must be a non-empty device token (max 4096 bytes)') }
    }
    if (
        body.platform === 'ios' && (token.length < 16
        || token.length > 512
        || token.length % 2 !== 0
        || !HEX_TOKEN_RE.test(token))
    ) {
        return { valid: false, response: pushError(400, 'bad_request', 'token must be a hex APNs device token') }
    }

    const envelope = body.envelope
    if (typeof envelope !== 'string' || envelope.length === 0) {
        return { valid: false, response: pushError(400, 'bad_request', 'envelope must be a non-empty base64 string') }
    }
    // base64 is ASCII: string length === byte size. Cap before validating
    // shape so oversized garbage is rejected cheaply.
    if (envelope.length > MAX_ENVELOPE_BYTES) {
        return {
            valid: false,
            response: pushError(413, 'too_large', `envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`)
        }
    }
    if (envelope.length % 4 !== 0 || !BASE64_RE.test(envelope)) {
        return { valid: false, response: pushError(400, 'bad_request', 'envelope must be standard base64') }
    }

    const collapseId = body.collapseId
    if (collapseId !== undefined && typeof collapseId !== 'string') {
        return { valid: false, response: pushError(400, 'bad_request', 'collapseId must be a string') }
    }

    const priority = body.priority
    if (priority !== undefined && priority !== 5 && priority !== 10) {
        return { valid: false, response: pushError(400, 'bad_request', 'priority must be 5 or 10') }
    }

    return {
        valid: true,
        request: {
            platform: body.platform,
            token: body.platform === 'ios' ? token.toLowerCase() : token,
            envelope,
            collapseId,
            priority: priority ?? 10
        }
    }
}

/** Map an APNs outcome onto the relay's response contract. */
function mapApnsResult(result: ApnsPushResult): { response: Response; outcome: string } {
    if (result.kind === 'delivered') {
        return { response: json(200, { ok: true }), outcome: 'delivered' }
    }
    if (result.kind === 'transport-error') {
        return {
            response: pushError(502, 'upstream'),
            outcome: 'upstream-transport'
        }
    }
    const unregistered =
        (result.status === 410 && result.reason === 'Unregistered')
        || (result.status === 400 && result.reason === 'BadDeviceToken')
    if (unregistered) {
        return {
            response: pushError(410, 'unregistered'),
            outcome: `unregistered (apns ${result.status})`
        }
    }
    if (result.status === 429) {
        // APNs can throttle delivery or provider-token updates. Both are
        // retryable and must retain the device registration.
        return {
            response: pushError(429, 'rate_limited'),
            outcome: `apns-throttled (apns ${result.status})`
        }
    }
    // Everything else (APNs 5xx, and 4xx caused by relay config such as
    // BadTopic / auth problems) is an upstream failure from the hub's view.
    return {
        response: pushError(502, 'upstream'),
        outcome: `upstream (apns ${result.status})`
    }
}

function mapFcmResult(result: FcmPushResult): { response: Response; outcome: string } {
    const response = result.kind === 'delivered' ? json(200, { ok: true })
        : result.kind === 'unregistered' ? pushError(410, 'unregistered')
        : result.kind === 'rate-limited' ? pushError(429, 'rate_limited')
        : pushError(502, 'upstream')
    return { response, outcome: `${result.kind}${result.status ? ` (fcm ${result.status})` : ''}` }
}

export function createRelayApp(deps: RelayAppDeps): RelayApp {
    const log = deps.log ?? ((line: string) => console.log(line))

    const handlePush = async (req: Request, clientIp: string | null): Promise<Response> => {
        let parsed: unknown
        try {
            parsed = await req.json()
        } catch {
            return pushError(400, 'bad_request', 'body must be JSON')
        }

        const validated = validatePushBody(parsed)
        if (!validated.valid) {
            return validated.response
        }
        const push = validated.request
        const tokenRef = hashedTokenPrefix(push.token, push.platform)
        const prefix = `[relay] push platform=${push.platform} token=${tokenRef}`
        if ((push.platform === 'ios' && !deps.apns) || (push.platform === 'android' && !deps.fcm)) {
            return pushError(501, 'unsupported_platform', `platform "${push.platform}" is not configured`)
        }

        if (!deps.ipLimiter.tryTake(clientIp ?? 'unknown')) {
            log(`${prefix} outcome=rate_limited (ip)`)
            return pushError(429, 'rate_limited')
        }
        if (!deps.tokenLimiter.tryTake(`${push.platform}:${push.token}`)) {
            log(`${prefix} outcome=rate_limited (token)`)
            return pushError(429, 'rate_limited')
        }

        const started = Date.now()
        try {
            const mapped = push.platform === 'ios'
                ? mapApnsResult(await deps.apns!.push({
                    deviceToken: push.token,
                    payload: buildApnsPayload(push.envelope),
                    collapseId: push.collapseId,
                    priority: push.priority
                }))
                : mapFcmResult(await deps.fcm!.push({ token: push.token, envelope: push.envelope, priority: push.priority }))
            log(`${prefix} outcome=${mapped.outcome} durationMs=${Date.now() - started}`)
            return mapped.response
        } catch {
            log(`${prefix} outcome=upstream durationMs=${Date.now() - started}`)
            return pushError(502, 'upstream')
        }
    }

    const handle = async (req: Request, clientIp: string | null): Promise<Response> => {
        const url = new URL(req.url)
        if (url.pathname === '/health') {
            if (req.method !== 'GET') {
                return pushError(405, 'method_not_allowed')
            }
            return json(200, { status: 'ok', service: SERVICE_NAME, version: deps.version })
        }
        if (url.pathname === '/v1/push') {
            if (req.method !== 'POST') {
                return pushError(405, 'method_not_allowed')
            }
            return handlePush(req, clientIp)
        }
        return pushError(404, 'not_found')
    }

    return { handle }
}

type RequestIpSource = {
    requestIP(req: Request): { address: string } | null
}

export function resolveClientIp(
    req: Request,
    server: RequestIpSource,
    trustProxy: boolean
): string | null {
    if (trustProxy) {
        const forwarded = req.headers.get('x-forwarded-for')
        if (forwarded !== null) {
            const first = forwarded.split(',')[0]?.trim()
            if (first !== undefined && first !== '') {
                return first
            }
        }
    }
    return server.requestIP(req)?.address ?? null
}

export async function startRelay(config: RelayConfig = loadConfigFromEnv()) {
    if (!config.apns && !config.fcm) throw new Error('Configure at least one push provider')
    let apns: ApnsClient | undefined
    if (config.apns) {
        const settings = config.apns
        const keyFile = Bun.file(settings.apnsKeyP8Path)
        if (!(await keyFile.exists())) {
            throw new Error('APNs key file not found; check RELAY_APNS_KEY_P8_PATH')
        }
        const jwtProvider = new ApnsJwtProvider({
            privateKeyPem: await keyFile.text(),
            keyId: settings.apnsKeyId,
            teamId: settings.apnsTeamId
        })
        await jwtProvider.getToken()
        apns = new Http2ApnsClient({
            baseUrl: APNS_HOSTS[settings.apnsEnv],
            topic: settings.apnsBundleId,
            jwtProvider
        })
    }
    let fcm: FcmClient | undefined
    if (config.fcm) {
        try {
            const account = parseServiceAccount(await Bun.file(config.fcm.serviceAccountPath).json())
            const auth = await FcmAccessTokenProvider.create(account)
            fcm = new HttpFcmClient(account.project_id, config.fcm.packageName, auth)
        } catch {
            throw new Error('Cannot load FCM credentials; check RELAY_FCM_SERVICE_ACCOUNT_PATH')
        }
    }
    const version = await readRelayVersion()
    const app = createRelayApp({
        apns,
        fcm,
        version,
        tokenLimiter: new TokenBucketLimiter(TOKEN_RATE_LIMIT),
        ipLimiter: new TokenBucketLimiter(IP_RATE_LIMIT)
    })

    const server = Bun.serve({
        port: config.port,
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
        fetch: (req, srv) => app.handle(req, resolveClientIp(req, srv, config.trustProxy))
    })
    console.log(
        `[relay] ${SERVICE_NAME} v${version} listening on :${server.port} `
        + `(ios: ${apns ? 'enabled' : 'off'}, android: ${fcm ? 'enabled' : 'off'})`
    )
    return server
}

if (import.meta.main) {
    startRelay().catch((err: unknown) => {
        console.error('[relay] fatal:', err instanceof Error ? err.message : err)
        process.exit(1)
    })
}
