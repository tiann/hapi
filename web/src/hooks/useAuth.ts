import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient } from '@/api/client'
import type { AuthResponse } from '@/types/api'

export type AuthSource =
    | { type: 'telegram'; initData: string }
    | { type: 'accessToken'; token: string }

function decodeJwtExpMs(token: string): number | null {
    const parts = token.split('.')
    if (parts.length < 2) return null

    const payloadBase64Url = parts[1] ?? ''
    const payloadBase64 = payloadBase64Url
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(payloadBase64Url.length / 4) * 4, '=')

    try {
        const decoded = globalThis.atob(payloadBase64)
        const payload = JSON.parse(decoded) as { exp?: unknown }
        if (typeof payload.exp !== 'number') return null
        return payload.exp * 1000
    } catch {
        return null
    }
}

function getAuthPayload(source: AuthSource): { initData: string } | { accessToken: string } {
    if (source.type === 'telegram') {
        return { initData: source.initData }
    }
    return { accessToken: source.token }
}

export function useAuth(authSource: AuthSource | null, baseUrl: string): {
    token: string | null
    user: AuthResponse['user'] | null
    api: ApiClient | null
    isLoading: boolean
    error: string | null
} {
    const [token, setToken] = useState<string | null>(null)
    const [user, setUser] = useState<AuthResponse['user'] | null>(null)
    const [isLoading, setIsLoading] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)
    const refreshPromiseRef = useRef<Promise<string | null> | null>(null)
    const tokenRef = useRef<string | null>(null)
    const lastRefreshAttemptRef = useRef<number>(0)

    // Stable reference for auth source to use in effects
    const authSourceRef = useRef(authSource)
    authSourceRef.current = authSource
    tokenRef.current = token

    const refreshAuth = useCallback(async (options?: {
        minTtlMs?: number
        hardFail?: boolean
        force?: boolean
    }): Promise<string | null> => {
        const currentSource = authSourceRef.current
        const currentToken = tokenRef.current
        if (!currentSource) {
            return null
        }

        const expMs = currentToken ? decodeJwtExpMs(currentToken) : null
        const minTtlMs = options?.minTtlMs ?? 0
        const now = Date.now()
        const ttlMs = expMs ? expMs - now : null
        const needsRefreshForTtl = ttlMs !== null && ttlMs <= minTtlMs
        if (!options?.force && ttlMs !== null && ttlMs > minTtlMs) {
            return currentToken
        }
        if (!options?.force && !needsRefreshForTtl && now - lastRefreshAttemptRef.current < 15_000) {
            return currentToken
        }
        if (refreshPromiseRef.current) {
            return await refreshPromiseRef.current
        }

        const run = async () => {
            lastRefreshAttemptRef.current = now

            try {
                const client = new ApiClient('', { baseUrl })
                const auth = await client.authenticate(getAuthPayload(currentSource))
                tokenRef.current = auth.token
                setToken(auth.token)
                setUser(auth.user)
                setError(null)
                return auth.token
            } catch {
                const isExpired = expMs ? Date.now() >= expMs : false
                if (options?.hardFail || isExpired) {
                    tokenRef.current = null
                    setToken(null)
                    setUser(null)
                    const msg = currentSource.type === 'telegram'
                        ? 'Session expired. Reopen the Mini App from Telegram.'
                        : 'Session expired. Please login again.'
                    setError(msg)
                }
                return null
            }
        }

        const refreshPromise = run()
        refreshPromiseRef.current = refreshPromise

        try {
            return await refreshPromise
        } finally {
            if (refreshPromiseRef.current === refreshPromise) {
                refreshPromiseRef.current = null
            }
        }
    }, [baseUrl])

    const api = useMemo(() => (
        token
            ? new ApiClient(token, {
                baseUrl,
                getToken: () => tokenRef.current,
                onUnauthorized: () => refreshAuth({ force: true })
            })
            : null
    ), [baseUrl, refreshAuth, token])

    useEffect(() => {
        let isCancelled = false

        async function run() {
            if (!authSource) {
                // No auth source - waiting for login
                return
            }

            setIsLoading(true)
            setError(null)
            try {
                const client = new ApiClient('', { baseUrl }) // temporary for auth call
                const auth = await client.authenticate(getAuthPayload(authSource))
                if (isCancelled) return
                setToken(auth.token)
                setUser(auth.user)
            } catch (e) {
                if (isCancelled) return
                setError(e instanceof Error ? e.message : 'Auth failed')
            } finally {
                if (!isCancelled) {
                    setIsLoading(false)
                }
            }
        }

        run()

        return () => {
            isCancelled = true
        }
    }, [authSource, baseUrl])

    useEffect(() => {
        tokenRef.current = null
        refreshPromiseRef.current = null
        lastRefreshAttemptRef.current = 0
        setToken(null)
        setUser(null)
        setError(null)
    }, [baseUrl])

    useEffect(() => {
        if (!token || !authSource) {
            return
        }

        const expMs = decodeJwtExpMs(token)
        if (!expMs) {
            return
        }

        let isCancelled = false
        let timeout: ReturnType<typeof setTimeout> | null = null

        const schedule = (delayMs: number) => {
            if (timeout) {
                clearTimeout(timeout)
            }
            timeout = setTimeout(() => void refresh(), Math.max(0, delayMs))
        }

        const refresh = async () => {
            if (isCancelled) return
            const refreshed = await refreshAuth({ force: true })
            if (isCancelled) return
            if (!refreshed && Date.now() < expMs) {
                schedule(15_000)
            }
        }

        schedule(expMs - 60_000 - Date.now())

        return () => {
            isCancelled = true
            if (timeout) {
                clearTimeout(timeout)
            }
        }
    }, [authSource, refreshAuth, token])

    useEffect(() => {
        if (!authSource) {
            return
        }

        const handleActive = () => {
            void refreshAuth({ minTtlMs: 60_000 })
        }

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                handleActive()
            }
        }

        window.addEventListener('focus', handleActive)
        document.addEventListener('visibilitychange', handleVisibilityChange)

        return () => {
            window.removeEventListener('focus', handleActive)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [authSource, refreshAuth])

    return { token, user, api, isLoading, error }
}
