import { PASSKEY_ORIGIN, passkeyBase64url } from '@hapi/protocol/passkey'
import {
    browserSupportsWebAuthn,
    WebAuthnError
} from '@simplewebauthn/browser'
import { ApiClient, ApiError } from '@/api/client'

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

const CALLBACK_MESSAGE = 'hapi-passkey-callback'

function cancelled(): Error {
    return new DOMException('Passkey sign-in cancelled', 'NotAllowedError')
}

/** Open synchronously in the click handler, before any network/crypto awaits.
 * The verifier remains in the initiating tab; the bridge never receives it. */
async function browserCeremony(api: ApiClient, operation: 'login' | 'register', name?: string) {
    const popup = window.open('about:blank', '_blank', 'popup,width=480,height=700')
    if (!popup) throw new ApiError('Allow popups to use Passkey sign-in', 0, 'passkey_popup_blocked')
    const state = passkeyBase64url(crypto.getRandomValues(new Uint8Array(32)))
    const verifier = passkeyBase64url(crypto.getRandomValues(new Uint8Array(32)))
    let timer: ReturnType<typeof setInterval> | undefined
    let listener: ((event: MessageEvent) => void) | undefined
    try {
        const codeChallenge = passkeyBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
        const callback = new Promise<string>((resolve, reject) => {
            listener = (event) => {
                if (event.origin !== window.location.origin || event.source !== popup || !event.data
                    || event.data.type !== CALLBACK_MESSAGE || event.data.state !== state) return
                if (event.data.error) {
                    reject(event.data.error === 'cancelled' ? cancelled() : new ApiError('Passkey sign-in failed', 401, String(event.data.error)))
                } else if (typeof event.data.code === 'string') resolve(event.data.code)
            }
            window.addEventListener('message', listener)
            const expiresAt = Date.now() + 5 * 60 * 1000
            timer = setInterval(() => {
                if (popup.closed || Date.now() >= expiresAt) reject(cancelled())
            }, 400)
        })
        // Attach a rejection handler while awaiting start (e.g. user closes early).
        void callback.catch(() => {})
        const { url } = await Promise.race([
            api.startPasskeyBrowser(operation, { state, codeChallenge, callbackOrigin: window.location.origin, name }),
            callback.then(() => { throw new Error('Unexpected early Passkey callback') })
        ])
        const target = new URL(url)
        if (target.origin !== PASSKEY_ORIGIN || target.pathname !== '/' || target.search || !target.hash) {
            throw new Error('Unexpected Passkey authentication page')
        }
        if (popup.closed) throw cancelled()
        popup.location.replace(target.href)
        const code = await callback
        const result = await api.exchangePasskeyCode(code, verifier)
        if (result.operation !== operation) throw new Error('Passkey operation mismatch')
        return result
    } finally {
        if (timer) clearInterval(timer)
        if (listener) window.removeEventListener('message', listener)
        popup.close()
    }
}

export async function signInWithPasskey(baseUrl: string): Promise<string> {
    const result = await browserCeremony(new ApiClient('', { baseUrl }), 'login')
    if (result.operation !== 'login') throw new Error('Passkey operation mismatch')
    return result.passkeySession
}

export async function registerPasskey(api: ApiClient, name?: string): Promise<void> {
    await browserCeremony(api, 'register', name)
}

/** Standalone popup landing: no auth/router or analytics, and no token in URL. */
export function completePasskeyCallback(): void {
    const params = new URLSearchParams(window.location.hash.slice(1))
    window.history.replaceState(null, '', window.location.pathname)
    if (window.opener && params.has('state')) {
        window.opener.postMessage({
            type: CALLBACK_MESSAGE, state: params.get('state'), code: params.get('code'), error: params.get('error')
        }, window.location.origin)
        window.close()
    }
    document.body.textContent = 'Return to the HAPI window to finish signing in.'
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
