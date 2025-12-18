import { useCallback, useEffect, useRef, useState } from 'react'
import { getTelegramWebApp, isTelegramEnvironment } from './useTelegram'
import type { AuthSource } from './useAuth'

const ACCESS_TOKEN_KEY = 'hapi_access_token'

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

function getStoredAccessToken(): string | null {
    try {
        return localStorage.getItem(ACCESS_TOKEN_KEY)
    } catch {
        return null
    }
}

function storeAccessToken(token: string): void {
    try {
        localStorage.setItem(ACCESS_TOKEN_KEY, token)
    } catch {
        // Ignore storage errors
    }
}

function clearStoredAccessToken(): void {
    try {
        localStorage.removeItem(ACCESS_TOKEN_KEY)
    } catch {
        // Ignore storage errors
    }
}

export function useAuthSource(): {
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

    // Initialize auth source on mount, with retry for delayed Telegram initData
    useEffect(() => {
        const telegramInitData = getTelegramInitData()

        if (telegramInitData) {
            // Telegram Mini App environment
            setAuthSource({ type: 'telegram', initData: telegramInitData })
            setIsTelegram(true)
            setIsLoading(false)
            return
        }

        // Check for stored access token as fallback
        const storedToken = getStoredAccessToken()
        if (storedToken) {
            setAuthSource({ type: 'accessToken', token: storedToken })
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
    }, [])

    const setAccessToken = useCallback((token: string) => {
        storeAccessToken(token)
        setAuthSource({ type: 'accessToken', token })
    }, [])

    const clearAuth = useCallback(() => {
        clearStoredAccessToken()
        setAuthSource(null)
    }, [])

    return {
        authSource,
        isLoading,
        isTelegram,
        setAccessToken,
        clearAuth
    }
}
