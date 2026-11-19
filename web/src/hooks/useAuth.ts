import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthProxyRedirectError } from '@/api/authProxy'
import { ApiClient, ApiError } from '@/api/client'
import type { AuthResponse } from '@/types/api'
import { TELEGRAM_AUTH_DISABLED_MESSAGE, type AuthConnectionFailure } from '@/lib/authConnection'

const AUTH_REQUEST_TIMEOUT_MS = 15_000

export type AuthSource =
    | { type: 'telegram'; initData: string }
    | { type: 'accessToken'; token: string }
    | { type: 'passkey'; session: string }

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

function getAuthPayload(
    source: AuthSource
): { initData: string } | { accessToken: string } | { passkeySession: string } {
    if (source.type === 'telegram') {
        return { initData: source.initData }
    }
    if (source.type === 'passkey') {
        return { passkeySession: source.session }
    }
    return { accessToken: source.token }
}

type AuthErrorKind = 'not_bound' | 'rejected' | 'redirected' | 'transient'

function classifyAuthError(error: unknown): AuthErrorKind {
    if (error instanceof ApiError) {
        if (error.status === 401 && error.code === 'not_bound') {
            return 'not_bound'
        }
        if (error.status === 400 || error.status === 401 || error.status === 403) {
            return 'rejected'
        }
        return 'transient'
    }
    if (error instanceof AuthProxyRedirectError) {
        return 'redirected'
    }
    return 'transient'
}

function getTransientRetryDelayMs(attempt: number, hasToken: boolean): number {
    if (hasToken) {
        return Math.min(15_000, 5_000 * (2 ** Math.min(attempt - 1, 2)))
    }
    return Math.min(15_000, 3_000 * (2 ** Math.min(attempt - 1, 3)))
}

const ACCESS_TOKEN_PREFIX = 'hapi_access_token::'

function rememberAccessToken(baseUrl: string, accessToken: string): void {
    try {
        localStorage.setItem(`${ACCESS_TOKEN_PREFIX}${baseUrl}`, accessToken)
    } catch {
        // Ignore storage errors (private mode, full quota, etc.)
    }
}

export function useAuth(authSource: AuthSource | null, baseUrl: string): {
    token: string | null
    user: AuthResponse['user'] | null
    api: ApiClient | null
    isLoading: boolean
    error: string | null
    needsBinding: boolean
    connectionError: AuthConnectionFailure | null
    retryConnection: () => void
    bind: (accessToken: string) => Promise<void>
    handleSseClosed: () => void
} {
    const [session, setSession] = useState<{
        token: string
        user: AuthResponse['user']
        authSource: AuthSource
        baseUrl: string
    } | null>(null)
    const [connectionFailure, setConnectionFailure] = useState<{ source: AuthSource; baseUrl: string; failure: AuthConnectionFailure } | null>(null)
    const connectionError = connectionFailure?.source === authSource && connectionFailure.baseUrl === baseUrl ? connectionFailure.failure : null
    const [isLoading, setIsLoading] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)
    const [needsBinding, setNeedsBinding] = useState<boolean>(false)
    const [transientRetryTick, setTransientRetryTick] = useState<number>(0)
    const refreshPromiseRef = useRef<Promise<string | null> | null>(null)
    const authAbortRef = useRef<AbortController | null>(null)
    const tokenRef = useRef<string | null>(null)
    const lastRefreshAttemptRef = useRef<number>(0)
    const authEpochRef = useRef<number>(0)
    const transientFailureCountRef = useRef<number>(0)
    const nextTransientRetryAtRef = useRef<number>(0)
    const lastErrorKindRef = useRef<AuthErrorKind | null>(null)

    const isCurrentSession =
        session !== null &&
        session.authSource === authSource &&
        session.baseUrl === baseUrl
    const token = isCurrentSession ? session.token : null
    const user = isCurrentSession ? session.user : null

    // Stable reference for auth source to use in effects
    const authSourceRef = useRef(authSource)
    authSourceRef.current = authSource
    tokenRef.current = token

    const refreshAuth = useCallback(async (options?: {
        minTtlMs?: number
        hardFail?: boolean
        force?: boolean
        expectedEpoch?: number
    }): Promise<string | null> => {
        const epoch = authEpochRef.current
        if (options?.expectedEpoch !== undefined && options.expectedEpoch !== epoch) {
            return null
        }
        const currentSource = authSourceRef.current
        const currentToken = tokenRef.current
        const hadToken = currentToken !== null
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
            const controller = new AbortController()
            authAbortRef.current = controller
            const timeout = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS)
            try {
                const client = new ApiClient('', { baseUrl })
                const auth = await client.authenticate(getAuthPayload(currentSource), { signal: controller.signal })
                if (authEpochRef.current !== epoch) {
                    return null
                }
                transientFailureCountRef.current = 0
                nextTransientRetryAtRef.current = 0
                lastErrorKindRef.current = null
                tokenRef.current = auth.token
                setSession({ token: auth.token, user: auth.user, authSource: currentSource, baseUrl })
                setError(null)
                setConnectionFailure(null)
                setNeedsBinding(false)
                setTransientRetryTick(0)
                return auth.token
            } catch (error) {
                if (authEpochRef.current !== epoch) {
                    return null
                }
                setConnectionFailure(null)
                const kind = classifyAuthError(error)
                lastErrorKindRef.current = kind

                if (currentSource.type === 'telegram' && kind === 'not_bound') {
                    transientFailureCountRef.current = 0
                    nextTransientRetryAtRef.current = 0
                    tokenRef.current = null
                    setSession(null)
                    setError(null)
                    setConnectionFailure(null)
                    setNeedsBinding(true)
                    return null
                }

                if (kind === 'rejected') {
                    transientFailureCountRef.current = 0
                    nextTransientRetryAtRef.current = 0
                    tokenRef.current = null
                    setSession(null)
                    setNeedsBinding(false)
                    if (hadToken) {
                        const msg = currentSource.type === 'telegram'
                            ? 'Session expired. Reopen the Mini App from Telegram.'
                            : 'Session expired. Please login again.'
                        setError(msg)
                    } else {
                        setError(error instanceof Error ? error.message : 'Auth failed')
                    }
                    return null
                }

                if (kind === 'redirected') {
                    transientFailureCountRef.current = 0
                    nextTransientRetryAtRef.current = 0
                    setTransientRetryTick(0)
                    const isExpired = expMs !== null ? Date.now() >= expMs : false
                    if (!hadToken || isExpired || options?.hardFail) {
                        tokenRef.current = null
                        setSession(null)
                        setNeedsBinding(false)
                        setError(error instanceof Error ? error.message : 'Auth failed')
                    }
                    return null
                }

                // Transient network / gateway failure: schedule bounded retries.
                // Preserve an active session even past JWT expMs so flaky networks
                // do not dump authenticated users onto the login prompt.
                setConnectionFailure({ source: currentSource, baseUrl, failure: error instanceof ApiError ? { status: error.status,
                    ...(error.status === 503 && error.code === TELEGRAM_AUTH_DISABLED_MESSAGE ? { diagnostic: TELEGRAM_AUTH_DISABLED_MESSAGE } : {}) } : {} })
                const attempt = transientFailureCountRef.current + 1
                transientFailureCountRef.current = attempt
                nextTransientRetryAtRef.current = Date.now() + getTransientRetryDelayMs(attempt, hadToken)
                setTransientRetryTick((tick) => tick + 1)
                if (!hadToken) {
                    setNeedsBinding(false)
                    setError(error instanceof Error ? error.message : 'Auth failed')
                }
                return null
            } finally {
                clearTimeout(timeout)
                if (authAbortRef.current === controller) authAbortRef.current = null
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

    const bind = useCallback(async (accessToken: string) => {
        const currentSource = authSourceRef.current
        if (!currentSource || currentSource.type !== 'telegram') {
            setError('Binding is only supported in Telegram.')
            return
        }

        const epoch = authEpochRef.current
        setIsLoading(true)
        setError(null)
        setConnectionFailure(null)
        try {
            const client = new ApiClient('', { baseUrl })
            const auth = await client.bind({ initData: currentSource.initData, accessToken })
            if (authEpochRef.current !== epoch) {
                return
            }
            transientFailureCountRef.current = 0
            nextTransientRetryAtRef.current = 0
            lastErrorKindRef.current = null
            refreshPromiseRef.current = null
            setTransientRetryTick(0)
            tokenRef.current = auth.token
            setSession({ token: auth.token, user: auth.user, authSource: currentSource, baseUrl })
            setNeedsBinding(false)
            // Persist the CLI access token so Settings → Companion pairing QR
            // can encode the same long-lived token in the deeplink. The PWA
            // already does this for browser/CLI logins via useAuthSource.
            rememberAccessToken(baseUrl, accessToken)
        } catch (error) {
            if (authEpochRef.current === epoch) {
                setError(error instanceof Error ? error.message : 'Binding failed')
            }
            throw error
        } finally {
            if (authEpochRef.current === epoch) {
                setIsLoading(false)
            }
        }
    }, [baseUrl])

    // Keep the ApiClient referentially stable across token *refreshes*: the client always reads
    // the live token via getToken (tokenRef), so it never needs rebuilding when the token value
    // changes — only when auth presence toggles (login/logout). Rebuilding on every refresh churns
    // `api`'s identity, which remounts everything keyed on it (VoiceBackendSession `[props.api]`,
    // GeneratedImageCard `[ctx.api, ...]`) and drives the remount/refetch storm. Issue #927.
    const hasToken = token !== null
    const api = useMemo(() => {
        if (!hasToken) {
            return null
        }
        const clientEpoch = authEpochRef.current
        return new ApiClient(tokenRef.current ?? '', {
            baseUrl,
            getToken: () => (authEpochRef.current === clientEpoch ? tokenRef.current : null),
            onUnauthorized: () => refreshAuth({ force: true, expectedEpoch: clientEpoch })
        })
    }, [baseUrl, refreshAuth, hasToken])

    useEffect(() => {
        authEpochRef.current += 1
        authAbortRef.current?.abort()
        authAbortRef.current = null
        const epoch = authEpochRef.current
        authSourceRef.current = authSource
        tokenRef.current = null
        refreshPromiseRef.current = null
        lastRefreshAttemptRef.current = 0
        transientFailureCountRef.current = 0
        nextTransientRetryAtRef.current = 0
        lastErrorKindRef.current = null
        setTransientRetryTick(0)
        setSession(null)
        setError(null)
        setConnectionFailure(null)
        setNeedsBinding(false)

        if (!authSource) {
            setIsLoading(false)
            return () => {
                authEpochRef.current += 1
                authAbortRef.current?.abort()
                authAbortRef.current = null
                refreshPromiseRef.current = null
            }
        }

        setIsLoading(true)
        void refreshAuth({ force: true }).finally(() => {
            if (authEpochRef.current === epoch) {
                setIsLoading(false)
            }
        })

        return () => {
            authEpochRef.current += 1
            authAbortRef.current?.abort()
            authAbortRef.current = null
            refreshPromiseRef.current = null
        }
    }, [authSource, baseUrl, refreshAuth])

    useEffect(() => {
        if (!authSource) {
            return
        }

        const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
        let delayMs: number | null = null

        if (!token) {
            if (transientFailureCountRef.current <= 0 || isHidden) {
                return
            }
            delayMs = Math.max(0, nextTransientRetryAtRef.current - Date.now())
        } else if (transientFailureCountRef.current > 0) {
            if (isHidden) {
                return
            }
            delayMs = Math.max(0, nextTransientRetryAtRef.current - Date.now())
        } else {
            const expMs = decodeJwtExpMs(token)
            if (!expMs) {
                return
            }
            delayMs = Math.max(0, expMs - 60_000 - Date.now())
        }

        const timeout = setTimeout(() => {
            void refreshAuth({ force: true })
        }, delayMs)

        return () => {
            clearTimeout(timeout)
        }
    }, [authSource, refreshAuth, token, transientRetryTick])

    useEffect(() => {
        if (!authSource) {
            return
        }

        const handleActive = () => {
            if (transientFailureCountRef.current > 0) {
                void refreshAuth({ force: true })
                return
            }
            if (lastErrorKindRef.current === 'rejected' || lastErrorKindRef.current === 'not_bound') {
                return
            }
            void refreshAuth({ minTtlMs: 60_000 })
        }

        const handleOnline = () => {
            if (transientFailureCountRef.current > 0 || !tokenRef.current) {
                if (
                    lastErrorKindRef.current === 'rejected' ||
                    lastErrorKindRef.current === 'not_bound' ||
                    lastErrorKindRef.current === 'redirected'
                ) {
                    return
                }
                void refreshAuth({ force: true })
                return
            }
            void refreshAuth({ minTtlMs: 60_000 })
        }

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                handleActive()
            }
        }

        window.addEventListener('focus', handleActive)
        window.addEventListener('online', handleOnline)
        document.addEventListener('visibilitychange', handleVisibilityChange)

        return () => {
            window.removeEventListener('focus', handleActive)
            window.removeEventListener('online', handleOnline)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [authSource, refreshAuth])

    const handleSseClosed = useCallback(() => {
        if (!authSourceRef.current || !tokenRef.current) {
            return
        }
        const now = Date.now()
        if (transientFailureCountRef.current > 0) {
            if (now < nextTransientRetryAtRef.current) {
                return
            }
            void refreshAuth({ force: true })
            return
        }
        const expMs = decodeJwtExpMs(tokenRef.current)
        if (expMs !== null && expMs - now <= 60_000) {
            void refreshAuth({ force: true })
            return
        }
        if (now - lastRefreshAttemptRef.current >= 15_000) {
            void refreshAuth({ force: true })
        }
    }, [refreshAuth])

    const retryConnection = useCallback(() => {
        const epoch = authEpochRef.current
        const retry = () => { void refreshAuth({ force: true, expectedEpoch: epoch }) }
        const pending = refreshPromiseRef.current
        if (pending) {
            authAbortRef.current?.abort()
            void pending.then(retry, retry)
        } else retry()
    }, [refreshAuth])
    return { token, user, api, isLoading, error, needsBinding, connectionError, retryConnection, bind, handleSseClosed }
}
