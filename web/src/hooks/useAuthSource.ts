import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getTelegramWebApp, isTelegramEnvironment } from './useTelegram'
import type { AuthSource } from './useAuth'

const ACCESS_TOKEN_PREFIX = 'hapi_access_token::'

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

const CLOUDFLARE_DISCOVERY_TIMEOUT_MS = 5000

function isSameOriginHub(baseUrl: string): boolean {
    if (typeof window === 'undefined') return false
    try {
        return new URL(baseUrl).origin === window.location.origin
    } catch {
        return false
    }
}

/**
 * Discover whether the hub is reachable through a configured Cloudflare
 * Access edge. Only same-origin hub requests are eligible. Any failure —
 * 404 from older hubs, disabled capability, network error, timeout — yields
 * false so the caller falls back to the existing manual login.
 */
async function discoverCloudflareAccess(baseUrl: string, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(`${baseUrl}/api/auth/methods`, {
            signal: controller.signal,
            headers: { 'cache-control': 'no-store' }
        })
        if (!response.ok) return false
        const data = await response.json() as { cloudflareAccess?: unknown }
        return data.cloudflareAccess === true
    } catch {
        return false
    } finally {
        clearTimeout(timer)
    }
}

export function useAuthSource(baseUrl: string): {
    authSource: AuthSource | null
    isLoading: boolean
    isTelegram: boolean
    setAccessToken: (token: string) => void
    clearAuth: () => void
} {
    const [authSource, setAuthSource] = useState<AuthSource | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [isTelegram, setIsTelegram] = useState(false)
    const retryCountRef = useRef(0)
    const accessTokenKey = useMemo(() => getAccessTokenKey(baseUrl), [baseUrl])

    // Initialize auth source on mount, with retry for delayed Telegram initData
    useEffect(() => {
        retryCountRef.current = 0
        setAuthSource(null)
        setIsTelegram(false)
        setIsLoading(true)

        let cancelled = false
        let committed = false
        let telegramInterval: ReturnType<typeof setInterval> | null = null
        let discoveryTimer: ReturnType<typeof setTimeout> | null = null
        let pollingStarted = false
        let pollingExhausted = false
        let pendingCloudflare = false

        const setTelegram = (initData: string) => {
            if (cancelled || committed) return
            committed = true
            setAuthSource({ type: 'telegram', initData })
            setIsTelegram(true)
            setIsLoading(false)
        }
        const setCloudflare = () => {
            if (cancelled || committed) return
            committed = true
            setAuthSource({ type: 'cloudflareAccess' })
            setIsLoading(false)
        }
        const setManual = () => {
            if (cancelled) return
            setIsLoading(false)
        }

        const startTelegramPolling = () => {
            if (pollingStarted || cancelled) return
            pollingStarted = true

            // Telegram environment detected - poll for delayed initData
            // Telegram WebApp SDK may initialize slightly after page mount
            const maxRetries = 20
            const retryInterval = 250 // ms

            telegramInterval = setInterval(() => {
                retryCountRef.current += 1
                const initData = getTelegramInitData()

                if (initData) {
                    setTelegram(initData)
                    if (telegramInterval) clearInterval(telegramInterval)
                } else if (retryCountRef.current >= maxRetries) {
                    // Give up - a Cloudflare discovery that resolved first is
                    // the fallback; otherwise show the login prompt.
                    pollingExhausted = true
                    if (telegramInterval) clearInterval(telegramInterval)
                    if (pendingCloudflare) {
                        setCloudflare()
                    } else {
                        setManual()
                    }
                }
            }, retryInterval)
        }

        const afterDiscovery = () => {
            if (cancelled) return
            // Check if we're in a Telegram environment before polling
            if (!isTelegramEnvironment()) {
                // Plain browser - show login prompt
                setManual()
                return
            }
            startTelegramPolling()
        }

        const telegramInitData = getTelegramInitData()

        if (telegramInitData) {
            // Telegram Mini App environment
            setTelegram(telegramInitData)
            return
        }

        // Check for URL token parameter (for direct access links)
        const urlToken = getTokenFromUrlParams()
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

        // Cloudflare Access discovery — same-origin hub requests only, bounded
        // to 5s. Older hubs (404), disabled capability, network failures and
        // cross-origin hubs all fall through to the existing manual login.
        if (!isSameOriginHub(baseUrl)) {
            afterDiscovery()
            return
        }

        if (isTelegramEnvironment()) {
            // Telegram keeps its delayed polling flow; an immediate initData
            // always wins over a concurrent discovery result.
            startTelegramPolling()
        }

        let discoveryDone = false
        const finishDiscovery = (available: boolean) => {
            if (cancelled || discoveryDone) return
            discoveryDone = true
            if (discoveryTimer) clearTimeout(discoveryTimer)
            if (!available) {
                afterDiscovery()
                return
            }
            if (isTelegramEnvironment()) {
                // Telegram outranks Cloudflare even when its initData arrives
                // late: hold the discovery result until the polling window
                // closes, then commit Telegram or fall back to Cloudflare.
                if (pollingExhausted) {
                    setCloudflare()
                } else {
                    pendingCloudflare = true
                }
                return
            }
            setCloudflare()
        }
        discoveryTimer = setTimeout(() => finishDiscovery(false), CLOUDFLARE_DISCOVERY_TIMEOUT_MS)
        void discoverCloudflareAccess(baseUrl, CLOUDFLARE_DISCOVERY_TIMEOUT_MS)
            .then(finishDiscovery)
            .catch(() => finishDiscovery(false))

        return () => {
            cancelled = true
            if (telegramInterval) clearInterval(telegramInterval)
            if (discoveryTimer) clearTimeout(discoveryTimer)
        }
    }, [accessTokenKey, baseUrl])

    const setAccessToken = useCallback((token: string) => {
        storeAccessToken(accessTokenKey, token)
        setAuthSource({ type: 'accessToken', token })
    }, [accessTokenKey])

    const clearAuth = useCallback(() => {
        clearStoredAccessToken(accessTokenKey)
        setAuthSource(null)
    }, [accessTokenKey])

    return {
        authSource,
        isLoading,
        isTelegram,
        setAccessToken,
        clearAuth
    }
}
