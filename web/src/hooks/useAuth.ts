import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient } from '@/api/client'
import type { AuthResponse } from '@/types/api'

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

export function useAuth(initData: string | null): {
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
    const refreshInFlightRef = useRef<boolean>(false)

    const api = useMemo(() => (token ? new ApiClient(token) : null), [token])

    useEffect(() => {
        let isCancelled = false

        async function run() {
            if (!initData) {
                setError('Missing Telegram initData (open inside Telegram)')
                return
            }

            setIsLoading(true)
            setError(null)
            try {
                const client = new ApiClient('') // temporary for auth call
                const auth = await client.authenticate(initData)
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
    }, [initData])

    useEffect(() => {
        if (!token || !initData) {
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
            if (refreshInFlightRef.current) return
            refreshInFlightRef.current = true

            try {
                const client = new ApiClient('')
                const auth = await client.authenticate(initData)
                if (isCancelled) return
                setToken(auth.token)
                setUser(auth.user)
            } catch {
                if (isCancelled) return
                if (Date.now() >= expMs) {
                    setToken(null)
                    setUser(null)
                    setError('Session expired. Reopen the Mini App from Telegram.')
                    return
                }
                schedule(15_000)
            } finally {
                refreshInFlightRef.current = false
            }
        }

        schedule(expMs - 60_000 - Date.now())

        return () => {
            isCancelled = true
            if (timeout) {
                clearTimeout(timeout)
            }
        }
    }, [initData, token])

    return { token, user, api, isLoading, error }
}
