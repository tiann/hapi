import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AuthSource } from '../model'

const ACCESS_TOKEN_PREFIX = 'hapi_access_token::'

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

export function useAuthSource(baseUrl: string): {
    authSource: AuthSource | null
    isLoading: boolean
    setAccessToken: (token: string) => void
    clearAuth: () => void
} {
    const [authSource, setAuthSource] = useState<AuthSource | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const accessTokenKey = useMemo(() => getAccessTokenKey(baseUrl), [baseUrl])

    // Initialize auth source on mount
    useEffect(() => {
        setAuthSource(null)
        setIsLoading(true)

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

        // Plain browser - show login prompt immediately
        setIsLoading(false)
    }, [accessTokenKey])

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
        setAccessToken,
        clearAuth
    }
}
