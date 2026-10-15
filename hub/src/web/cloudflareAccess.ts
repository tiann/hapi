import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import type { JWSHeaderParameters, FlattenedJWSInput } from 'jose'
import type { CloudflareAccessConfig } from '../config/cloudflareAccess'
import { getConfiguration } from '../configuration'

export const CLOUDFLARE_ACCESS_ASSERTION_MAX_BYTES = 16 * 1024

export interface VerifiedCloudflareAccess {
    readonly kind: 'ok'
    readonly subject: string
    readonly email: string
    readonly namespace: string
    readonly expiresAt: number
}

export type CloudflareAccessVerificationFailure =
    | { readonly kind: 'invalid' }
    | { readonly kind: 'forbidden' }
    | { readonly kind: 'unavailable' }

export type CloudflareAccessVerificationResult = VerifiedCloudflareAccess | CloudflareAccessVerificationFailure

export type CloudflareAccessKeyResolver = (
    protectedHeader: JWSHeaderParameters | undefined,
    token: FlattenedJWSInput | undefined
) => Promise<CryptoKey>

export interface CloudflareAccessVerifier {
    verify(assertion: string): Promise<CloudflareAccessVerificationResult>
}

export interface CreateCloudflareAccessVerifierOptions {
    /** Key resolver override (tests only; production always uses the configured remote JWKS). */
    keyResolver?: CloudflareAccessKeyResolver
}

function assertionByteLength(assertion: string): number {
    return new TextEncoder().encode(assertion).byteLength
}

/**
 * Create a verifier for Cloudflare Access JWT assertions.
 * The issuer and JWKS URL are always derived from the configured team domain;
 * they are never taken from JWT claims or incoming Host/Forwarded headers.
 */
export function createCloudflareAccessVerifier(
    config: CloudflareAccessConfig,
    options: CreateCloudflareAccessVerifierOptions = {}
): CloudflareAccessVerifier {
    const keyResolver = options.keyResolver ?? createRemoteJWKSet(
        new URL(`https://${config.teamDomain}/cdn-cgi/access/certs`),
        { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 600_000 }
    )
    const issuer = `https://${config.teamDomain}`
    const audience = config.audience

    return {
        async verify(assertion: string): Promise<CloudflareAccessVerificationResult> {
            if (!assertion || assertionByteLength(assertion) > CLOUDFLARE_ACCESS_ASSERTION_MAX_BYTES) {
                return { kind: 'invalid' }
            }

            let payload: Record<string, unknown>
            try {
                const verified = await jwtVerify(assertion, keyResolver, {
                    algorithms: ['RS256'],
                    issuer,
                    audience
                })
                payload = verified.payload as Record<string, unknown>
            } catch (error) {
                // JWKSNoMatchingKey means the key service answered successfully but
                // holds no key for this token — an invalid token.
                if (error instanceof errors.JWKSNoMatchingKey) {
                    return { kind: 'invalid' }
                }
                // Key-service failures: timeout, non-200 response, malformed or
                // ambiguous JWKS JSON, and network-level fetch errors.
                if (error instanceof errors.JWKSTimeout
                    || error instanceof errors.JWKSInvalid
                    || error instanceof errors.JWKSMultipleMatchingKeys) {
                    return { kind: 'unavailable' }
                }
                if (error instanceof errors.JOSEError) {
                    // The remote key set loader reports non-200 responses and
                    // unparseable JWKS bodies as a generic JOSEError.
                    if (error.code === 'ERR_JOSE_GENERIC') {
                        return { kind: 'unavailable' }
                    }
                    // Token-level failures: algorithm, signature, expiry,
                    // issuer, audience.
                    return { kind: 'invalid' }
                }
                return { kind: 'unavailable' }
            }

            const { exp, sub } = payload
            if (typeof exp !== 'number' || !Number.isFinite(exp) || !Number.isInteger(exp)) {
                return { kind: 'invalid' }
            }
            if (typeof sub !== 'string' || sub.length === 0) {
                return { kind: 'invalid' }
            }

            const rawEmail = payload.email
            if (typeof rawEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
                return { kind: 'invalid' }
            }
            const email = rawEmail.trim().toLowerCase()

            const namespace = config.users[email]
            if (namespace === undefined) {
                return { kind: 'forbidden' }
            }

            return {
                kind: 'ok',
                subject: sub,
                email,
                namespace,
                expiresAt: exp
            }
        }
    }
}

let cachedVerifier: CloudflareAccessVerifier | null = null
let cachedVerifierConfig: CloudflareAccessConfig | null = null

/**
 * Production verifier for the configured Cloudflare Access bundle.
 * Returns null when the feature is disabled. The remote JWKS set is created
 * once per configuration and reused across requests.
 */
export function getCloudflareAccessVerifier(): CloudflareAccessVerifier | null {
    const config = getConfiguration().cloudflareAccess
    if (!config) {
        return null
    }
    if (!cachedVerifier || cachedVerifierConfig !== config) {
        cachedVerifier = createCloudflareAccessVerifier(config)
        cachedVerifierConfig = config
    }
    return cachedVerifier
}
