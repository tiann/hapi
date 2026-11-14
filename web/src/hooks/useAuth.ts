import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient, ApiError } from '@/api/client'
import { decodeJwtExpMs, decodeJwtIdentityKey, isCloudflareToken } from '@/lib/authIdentity'
import type { AuthResponse } from '@/types/api'

export type AuthSource =
    | { type: 'telegram'; initData: string }
    | { type: 'accessToken'; token: string }
    | { type: 'cloudflareAccess' }

async function authenticateWith(client: ApiClient, source: AuthSource): Promise<AuthResponse> {
    if (source.type === 'cloudflareAccess') {
        return await client.authenticateWithCloudflare()
    }
    if (source.type === 'telegram') {
        return await client.authenticate({ initData: source.initData })
    }
    return await client.authenticate({ accessToken: source.token })
}

function isNotBoundError(error: unknown): boolean {
    return error instanceof ApiError && error.status === 401 && error.code === 'not_bound'
}

function isTerminalAuthRejection(error: unknown, sourceType: AuthSource['type']): boolean {
    if (!(error instanceof ApiError)) {
        return false
    }
    if (error.status === 401 || error.status === 403) {
        return true
    }
    return sourceType === 'cloudflareAccess' && error.status === 404
}

const ACCESS_TOKEN_PREFIX = 'hapi_access_token::'

function rememberAccessToken(baseUrl: string, accessToken: string): void {
    try {
        localStorage.setItem(`${ACCESS_TOKEN_PREFIX}${baseUrl}`, accessToken)
    } catch {
        // Ignore storage errors (private mode, full quota, etc.)
    }
}

export function useAuth(
    authSource: AuthSource | null,
    baseUrl: string,
    options?: { onIdentityChange?: () => void }
): {
    token: string | null
    user: AuthResponse['user'] | null
    api: ApiClient | null
    isLoading: boolean
    error: string | null
    needsBinding: boolean
    bind: (accessToken: string) => Promise<void>
    retry: () => Promise<string | null>
} {
    const [token, setToken] = useState<string | null>(null)
    const [user, setUser] = useState<AuthResponse['user'] | null>(null)
    const [isLoading, setIsLoading] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)
    const [needsBinding, setNeedsBinding] = useState<boolean>(false)
    const refreshPromiseRef = useRef<Promise<string | null> | null>(null)
    const tokenRef = useRef<string | null>(null)
    const lastRefreshAttemptRef = useRef<number>(0)
    const activeIdentityRef = useRef<string | null>(null)
    const onIdentityChangeRef = useRef(options?.onIdentityChange)
    onIdentityChangeRef.current = options?.onIdentityChange

    // Stable reference for auth source to use in effects
    const authSourceRef = useRef(authSource)
    authSourceRef.current = authSource
    tokenRef.current = token

    const applyAuthenticatedSession = useCallback((auth: AuthResponse) => {
        const nextIdentity = decodeJwtIdentityKey(auth.token)
        if (activeIdentityRef.current !== null && nextIdentity !== activeIdentityRef.current) {
            onIdentityChangeRef.current?.()
        }
        activeIdentityRef.current = nextIdentity
        tokenRef.current = auth.token
        setToken(auth.token)
        setUser(auth.user)
        setError(null)
        setNeedsBinding(false)
    }, [])

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
                const auth = await authenticateWith(client, currentSource)
                applyAuthenticatedSession(auth)
                return auth.token
            } catch (error) {
                if (currentSource.type === 'telegram' && isNotBoundError(error)) {
                    tokenRef.current = null
                    setToken(null)
                    setUser(null)
                    setError(null)
                    setNeedsBinding(true)
                    return null
                }
                const isExpired = expMs ? Date.now() >= expMs : false
                const isTerminal = isTerminalAuthRejection(error, currentSource.type)
                if (options?.hardFail || isExpired || isTerminal || currentToken === null) {
                    tokenRef.current = null
                    setToken(null)
                    setUser(null)
                    const msg = currentSource.type === 'telegram' && !isTerminal
                        ? 'Session expired. Reopen the Mini App from Telegram.'
                        : error instanceof Error && (isTerminal || currentToken === null)
                            ? error.message
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

    const bind = useCallback(async (accessToken: string) => {
        const currentSource = authSourceRef.current
        if (!currentSource || currentSource.type !== 'telegram') {
            setError('Binding is only supported in Telegram.')
            return
        }

        setIsLoading(true)
        setError(null)
        try {
            const client = new ApiClient('', { baseUrl })
            const auth = await client.bind({ initData: currentSource.initData, accessToken })
            applyAuthenticatedSession(auth)
            // Persist the CLI access token so Settings → Companion pairing QR
            // can encode the same long-lived token in the deeplink. The PWA
            // already does this for browser/CLI logins via useAuthSource.
            rememberAccessToken(baseUrl, accessToken)
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Binding failed')
            throw error
        } finally {
            setIsLoading(false)
        }
    }, [baseUrl])

    const retry = useCallback(async (): Promise<string | null> => {
        if (!authSourceRef.current) {
            return null
        }
        setIsLoading(true)
        setError(null)
        setNeedsBinding(false)
        try {
            return await refreshAuth({ force: true })
        } finally {
            setIsLoading(false)
        }
    }, [refreshAuth])

    // Keep the ApiClient referentially stable across token *refreshes*: the client always reads
    // the live token via getToken (tokenRef), so it never needs rebuilding when the token value
    // changes — only when auth presence toggles (login/logout). Rebuilding on every refresh churns
    // `api`'s identity, which remounts everything keyed on it (VoiceBackendSession `[props.api]`,
    // GeneratedImageCard `[ctx.api, ...]`) and drives the remount/refetch storm. Issue #927.
    const hasToken = token !== null
    const api = useMemo(() => (
        hasToken
            ? new ApiClient(tokenRef.current ?? '', {
                baseUrl,
                getToken: () => tokenRef.current,
                onUnauthorized: () => refreshAuth({ force: true })
            })
            : null
    ), [baseUrl, refreshAuth, hasToken])

    useEffect(() => {
        let isCancelled = false

        async function run() {
            if (!authSource) {
                // No auth source - waiting for login
                setNeedsBinding(false)
                return
            }

            setIsLoading(true)
            setError(null)
            setNeedsBinding(false)
            try {
                const client = new ApiClient('', { baseUrl }) // temporary for auth call
                const auth = await authenticateWith(client, authSource)
                if (isCancelled) return
                applyAuthenticatedSession(auth)
            } catch (e) {
                if (isCancelled) return
                if (authSource.type === 'telegram' && isNotBoundError(e)) {
                    setToken(null)
                    setUser(null)
                    setError(null)
                    setNeedsBinding(true)
                    return
                }
                setNeedsBinding(false)
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
        activeIdentityRef.current = null
        setToken(null)
        setUser(null)
        setError(null)
        setNeedsBinding(false)
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
            // Cloudflare-derived JWTs expire with the Access assertion, so the
            // final-60s window can schedule 0 on every changed token and loop
            // the login endpoint. Bound CF scheduled refreshes to one per 15s;
            // force/onUnauthorized refreshes stay immediate.
            const minDelayMs = isCloudflareToken(token) ? 15_000 : 0
            timeout = setTimeout(() => void refresh(), Math.max(minDelayMs, delayMs))
        }

        const refresh = async () => {
            if (isCancelled) return
            const refreshed = await refreshAuth({ force: true })
            if (isCancelled) return
            if (!refreshed) {
                if (Date.now() < expMs) {
                    schedule(15_000)
                } else if (tokenRef.current === token) {
                    tokenRef.current = null
                    setToken(null)
                    setUser(null)
                    setError(
                        authSource.type === 'telegram'
                            ? 'Session expired. Reopen the Mini App from Telegram.'
                            : 'Session expired. Please login again.'
                    )
                }
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

    return { token, user, api, isLoading, error, needsBinding, bind, retry }
}
