import { readFileSync } from 'node:fs'
import * as jose from 'jose'

export type ServiceAccount = {
    client_email: string
    private_key: string
    project_id?: string
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

let cachedToken: { accessToken: string; expiresAtMs: number } | null = null

export function loadServiceAccount(path: string): ServiceAccount {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as ServiceAccount
    if (!parsed.client_email || !parsed.private_key) {
        throw new Error('FCM service account JSON missing client_email or private_key')
    }
    return parsed
}

export async function getFcmAccessToken(serviceAccount: ServiceAccount): Promise<string> {
    const nowMs = Date.now()
    if (cachedToken && cachedToken.expiresAtMs > nowMs + 60_000) {
        return cachedToken.accessToken
    }

    const nowSec = Math.floor(nowMs / 1000)
    const key = await jose.importPKCS8(serviceAccount.private_key, 'RS256')
    const assertion = await new jose.SignJWT({ scope: FCM_SCOPE })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(serviceAccount.client_email)
        .setSubject(serviceAccount.client_email)
        .setAudience('https://oauth2.googleapis.com/token')
        .setIssuedAt(nowSec)
        .setExpirationTime(nowSec + 3600)
        .sign(key)

    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion
        })
    })

    if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`FCM OAuth token exchange failed: ${response.status} ${body}`)
    }

    const json = await response.json() as { access_token?: string; expires_in?: number }
    if (!json.access_token) {
        throw new Error('FCM OAuth response missing access_token')
    }

    const expiresInSec = json.expires_in ?? 3600
    cachedToken = {
        accessToken: json.access_token,
        expiresAtMs: nowMs + expiresInSec * 1000
    }
    return cachedToken.accessToken
}

/** Test helper */
export function clearFcmAccessTokenCache(): void {
    cachedToken = null
}
