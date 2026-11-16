import {
    browserSupportsWebAuthn,
    startAuthentication,
    startRegistration,
    WebAuthnError
} from '@simplewebauthn/browser'
import { ApiClient } from '@/api/client'

/** WebAuthn needs a secure context; plain-HTTP LAN addresses are not one. */
export function isPasskeySupported(): boolean {
    return typeof window !== 'undefined' && window.isSecureContext && browserSupportsWebAuthn()
}

/** The user dismissed or timed out the browser's passkey sheet. */
export function isPasskeyCancelled(error: unknown): boolean {
    if (error instanceof WebAuthnError) {
        return error.code === 'ERROR_CEREMONY_ABORTED' || error.name === 'NotAllowedError'
    }
    return error instanceof Error && error.name === 'NotAllowedError'
}

/** Run the sign-in ceremony and return the long-lived passkey session. */
export async function signInWithPasskey(baseUrl: string): Promise<string> {
    const client = new ApiClient('', { baseUrl })
    const optionsJSON = await client.getPasskeyLoginOptions()
    const response = await startAuthentication({ optionsJSON })
    const result = await client.verifyPasskeyLogin(response)
    return result.passkeySession
}

export async function registerPasskey(api: ApiClient, name?: string): Promise<void> {
    const optionsJSON = await api.getPasskeyRegistrationOptions()
    const response = await startRegistration({ optionsJSON })
    await api.verifyPasskeyRegistration(response, name)
}

/** Best-effort label for a new passkey, e.g. "Chrome on macOS". */
export function defaultPasskeyName(): string {
    if (typeof navigator === 'undefined') return 'Passkey'
    const ua = navigator.userAgent
    const browser = /Edg\//.test(ua) ? 'Edge'
        : /Firefox\//.test(ua) ? 'Firefox'
            : /Chrome\//.test(ua) ? 'Chrome'
                : /Safari\//.test(ua) ? 'Safari'
                    : 'Browser'
    const os = /iPhone|iPad/.test(ua) ? 'iOS'
        : /Android/.test(ua) ? 'Android'
            : /Mac OS X/.test(ua) ? 'macOS'
                : /Windows/.test(ua) ? 'Windows'
                    : /Linux/.test(ua) ? 'Linux'
                        : ''
    return os ? `${browser} on ${os}` : browser
}
