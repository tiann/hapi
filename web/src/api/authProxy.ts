/** Message of AuthProxyRedirectError; the login screen keys its redirect notice on it. */
export const AUTH_PROXY_REDIRECT_MESSAGE = 'Request was redirected'

export class AuthProxyRedirectError extends Error {
    readonly hubOrigin: string

    constructor(hubOrigin: string) {
        super(AUTH_PROXY_REDIRECT_MESSAGE)
        this.name = 'AuthProxyRedirectError'
        this.hubOrigin = hubOrigin
    }
}

export async function fetchThroughAuthProxy(input: string, init?: RequestInit): Promise<Response> {
    const first = await fetch(input, { ...init, redirect: 'manual' })
    if (first.type !== 'opaqueredirect') {
        return first
    }

    // The hub never redirects, so the 3xx came from something in front of it. A gateway that
    // redirects before forwarding has not passed the request on, so one retry with the caller's
    // init is safe and lets ordinary redirects (http -> https) succeed. Only a failing retry
    // means the browser could not follow the redirect (e.g. cross-origin without CORS).
    try {
        return await fetch(input, init)
    } catch (e) {
        if (e instanceof TypeError) {
            throw new AuthProxyRedirectError(new URL(input, window.location.href).origin)
        }
        throw e
    }
}

export function buildAuthProxyReauthUrl(hubOrigin: string, now?: number): string {
    return `${hubOrigin}/?hapi_reauth=${now ?? Date.now()}`
}

export function openAuthProxySignIn(hubOrigin: string, win: Window = window): void {
    const url = buildAuthProxyReauthUrl(hubOrigin)
    if (hubOrigin === win.location.origin) {
        win.location.assign(url)
        return
    }
    win.open(url, '_blank', 'noopener,noreferrer')
}
