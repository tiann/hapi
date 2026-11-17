import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getTelegramWebApp, isTelegramEnvironment } from './useTelegram'
import type { AuthSource } from './useAuth'

const ACCESS_TOKEN_PREFIX = 'hapi_access_token::'
const PASSKEY_SESSION_PREFIX = 'hapi_passkey_session::'

function getTelegramInitData(): string | null {
    const tg = getTelegramWebApp()
    if (tg?.initData) {
        return tg.initData
    }

    // Fallback: check URL parameters (for testing or alternative flows)
    const query = new URLSearchParams(window.location.search)
    const tgWebAppData = query.get('tgWebAppData')
    if (tgWebAppData) {
        return tgWebAppData
    }

    const initData = query.get('initData')
    return initData || null
}

function getTokenFromUrlParams(): string | null {
    if (typeof window === 'undefined') return null
    const query = new URLSearchParams(window.location.search)
    return query.get('token')
}

function getAccessTokenKey(baseUrl: string): string {
    return `${ACCESS_TOKEN_PREFIX}${baseUrl}`
}

function getPasskeySessionKey(baseUrl: string): string {
    return `${PASSKEY_SESSION_PREFIX}${baseUrl}`
}

function getStoredAccessToken(key: string): string | null {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function storeAccessToken(key: string, token: string): void {
    try {
        localStorage.setItem(key, token)
    } catch {
        // Ignore storage errors
    }
}

function clearStoredAccessToken(key: string): void {
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

export function useAuthSource(baseUrl: string): {
    authSource: AuthSource | null
    isLoading: boolean
    isTelegram: boolean
    setAccessToken: (token: string) => void
    setPasskeySession: (session: string, hubUrl?: string) => void
    clearAuth: () => void
} {
    const [sourceState, setSourceState] = useState<{ hub: string; source: AuthSource | null }>({ hub: baseUrl, source: null })
    // Hide the previous Hub's credentials synchronously, before effects run.
    const authSource = sourceState.hub === baseUrl ? sourceState.source : null
    const setAuthSource = useCallback((source: AuthSource | null) => setSourceState({ hub: baseUrl, source }), [baseUrl])
    const urlCredential = useRef({ hub: baseUrl, token: getTokenFromUrlParams() })
    const [isLoading, setIsLoading] = useState(true)
    const [isTelegram, setIsTelegram] = useState(false)
    const retryCountRef = useRef(0)
    const accessTokenKey = useMemo(() => getAccessTokenKey(baseUrl), [baseUrl])
    const passkeySessionKey = useMemo(() => getPasskeySessionKey(baseUrl), [baseUrl])

    // Initialize auth source on mount, with retry for delayed Telegram initData
    useEffect(() => {
        retryCountRef.current = 0
        setAuthSource(null)
        setIsTelegram(false)
        setIsLoading(true)

        const telegramInitData = getTelegramInitData()

        if (telegramInitData) {
            // Telegram Mini App environment
            setAuthSource({ type: 'telegram', initData: telegramInitData })
            setIsTelegram(true)
            setIsLoading(false)
            return
        }

        // Check for URL token parameter (for direct access links)
        const urlToken = urlCredential.current.hub === baseUrl ? urlCredential.current.token : null
        if (urlToken) {
            storeAccessToken(accessTokenKey, urlToken) // Save to localStorage for refresh
            setAuthSource({ type: 'accessToken', token: urlToken })
            setIsLoading(false)
            return
        }

        // Check for stored access token as fallback
        const storedToken = getStoredAccessToken(accessTokenKey)
        if (storedToken) {
            setAuthSource({ type: 'accessToken', token: storedToken })
            setIsLoading(false)
            return
        }

        // Then a previous passkey sign-in (stores no CLI token in the browser)
        const storedPasskeySession = getStoredAccessToken(passkeySessionKey)
        if (storedPasskeySession) {
            setAuthSource({ type: 'passkey', session: storedPasskeySession })
            setIsLoading(false)
            return
        }

        // Check if we're in a Telegram environment before polling
        if (!isTelegramEnvironment()) {
            // Plain browser - show login prompt immediately
            setIsLoading(false)
            return
        }

        // Telegram environment detected - poll for delayed initData
        // Telegram WebApp SDK may initialize slightly after page mount
        const maxRetries = 20
        const retryInterval = 250 // ms

        const interval = setInterval(() => {
            retryCountRef.current += 1
            const initData = getTelegramInitData()

            if (initData) {
                setAuthSource({ type: 'telegram', initData })
                setIsTelegram(true)
                setIsLoading(false)
                clearInterval(interval)
            } else if (retryCountRef.current >= maxRetries) {
                // Give up - show login prompt for browser access
                setIsLoading(false)
                clearInterval(interval)
            }
        }, retryInterval)

        return () => {
            clearInterval(interval)
        }
    }, [accessTokenKey, passkeySessionKey, baseUrl, setAuthSource])

    const setAccessToken = useCallback((token: string) => {
        storeAccessToken(accessTokenKey, token)
        clearStoredAccessToken(passkeySessionKey)
        setAuthSource({ type: 'accessToken', token })
    }, [accessTokenKey, passkeySessionKey, setAuthSource])

    const setPasskeySession = useCallback((session: string, hubUrl = baseUrl) => {
        // A previous pairing link must not reselect its Hub or replay its token
        // after discovery switches Hubs (including on the next page reload).
        urlCredential.current.token = null
        const url = new URL(window.location.href)
        url.searchParams.delete('hub')
        url.searchParams.delete('token')
        window.history.replaceState(null, '', url.pathname + url.search + url.hash)
        // A stored access token would take precedence on the next load; drop it
        // so a stale/rotated token cannot shadow the passkey session.
        clearStoredAccessToken(getAccessTokenKey(hubUrl))
        storeAccessToken(getPasskeySessionKey(hubUrl), session)
        if (hubUrl === baseUrl) setAuthSource({ type: 'passkey', session })
    }, [baseUrl, setAuthSource])

    const clearAuth = useCallback(() => {
        clearStoredAccessToken(accessTokenKey)
        clearStoredAccessToken(passkeySessionKey)
        setAuthSource(null)
    }, [accessTokenKey, passkeySessionKey, setAuthSource])

    return {
        authSource,
        isLoading,
        isTelegram,
        setAccessToken,
        setPasskeySession,
        clearAuth
    }
}
