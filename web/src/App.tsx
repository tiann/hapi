import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Outlet, useLocation, useMatchRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { getTelegramWebApp } from '@/hooks/useTelegram'
import { initializeTheme } from '@/hooks/useTheme'
import { useAuth } from '@/hooks/useAuth'
import { useAuthSource } from '@/hooks/useAuthSource'
import { useServerUrl } from '@/hooks/useServerUrl'
import { useSSE } from '@/hooks/useSSE'
import { useSyncingState } from '@/hooks/useSyncingState'
import { queryKeys } from '@/lib/query-keys'
import { AppContextProvider } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { LoginPrompt } from '@/components/LoginPrompt'
import { InstallPrompt } from '@/components/InstallPrompt'
import { OfflineBanner } from '@/components/OfflineBanner'
import { SyncingBanner } from '@/components/SyncingBanner'
import { LoadingState } from '@/components/LoadingState'

export function App() {
    const { serverUrl, baseUrl, setServerUrl, clearServerUrl } = useServerUrl()
    const { authSource, isLoading: isAuthSourceLoading, setAccessToken } = useAuthSource(baseUrl)
    const { token, api, isLoading: isAuthLoading, error: authError } = useAuth(authSource, baseUrl)
    const goBack = useAppGoBack()
    const pathname = useLocation({ select: (location) => location.pathname })
    const matchRoute = useMatchRoute()

    useEffect(() => {
        const tg = getTelegramWebApp()
        tg?.ready()
        tg?.expand()
        initializeTheme()
    }, [])

    useEffect(() => {
        const preventDefault = (event: Event) => {
            event.preventDefault()
        }

        const onWheel = (event: WheelEvent) => {
            if (event.ctrlKey) {
                event.preventDefault()
            }
        }

        const onKeyDown = (event: KeyboardEvent) => {
            const modifier = event.ctrlKey || event.metaKey
            if (!modifier) return
            if (event.key === '+' || event.key === '-' || event.key === '=' || event.key === '0') {
                event.preventDefault()
            }
        }

        document.addEventListener('gesturestart', preventDefault as EventListener, { passive: false })
        document.addEventListener('gesturechange', preventDefault as EventListener, { passive: false })
        document.addEventListener('gestureend', preventDefault as EventListener, { passive: false })

        window.addEventListener('wheel', onWheel, { passive: false })
        window.addEventListener('keydown', onKeyDown)

        return () => {
            document.removeEventListener('gesturestart', preventDefault as EventListener)
            document.removeEventListener('gesturechange', preventDefault as EventListener)
            document.removeEventListener('gestureend', preventDefault as EventListener)

            window.removeEventListener('wheel', onWheel)
            window.removeEventListener('keydown', onKeyDown)
        }
    }, [])

    useEffect(() => {
        const tg = getTelegramWebApp()
        const backButton = tg?.BackButton
        if (!backButton) return

        if (pathname === '/' || pathname === '/sessions') {
            backButton.offClick(goBack)
            backButton.hide()
            return
        }

        backButton.show()
        backButton.onClick(goBack)
        return () => {
            backButton.offClick(goBack)
            backButton.hide()
        }
    }, [goBack, pathname])
    const queryClient = useQueryClient()
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId' })
    const selectedSessionId = sessionMatch ? sessionMatch.sessionId : null
    const { isSyncing, startSync, endSync } = useSyncingState()
    const syncTokenRef = useRef(0)
    const isFirstConnectRef = useRef(true)
    const baseUrlRef = useRef(baseUrl)

    useEffect(() => {
        if (baseUrlRef.current === baseUrl) {
            return
        }
        baseUrlRef.current = baseUrl
        isFirstConnectRef.current = true
        syncTokenRef.current = 0
        queryClient.clear()
    }, [baseUrl, queryClient])

    const handleSseConnect = useCallback(() => {
        // Increment token to track this specific connection
        const token = ++syncTokenRef.current

        // Only force show banner on first connect (page load)
        // Subsequent connects (session switches) use non-forced mode
        // which only shows banner when returning from background
        if (isFirstConnectRef.current) {
            isFirstConnectRef.current = false
            startSync({ force: true })
        } else {
            startSync()
        }
        const invalidations = [
            queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
            ...(selectedSessionId ? [
                queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) }),
                queryClient.invalidateQueries({ queryKey: queryKeys.messages(selectedSessionId) })
            ] : [])
        ]
        Promise.all(invalidations)
            .catch((error) => {
                console.error('Failed to invalidate queries on SSE connect:', error)
            })
            .finally(() => {
                // Only end sync if this is still the latest connection
                if (syncTokenRef.current === token) {
                    endSync()
                }
            })
    }, [queryClient, selectedSessionId, startSync, endSync])

    const handleSseEvent = useCallback(() => {}, [])

    const eventSubscription = useMemo(() => {
        if (selectedSessionId) {
            return { sessionId: selectedSessionId }
        }
        return { all: true }
    }, [selectedSessionId])

    useSSE({
        enabled: Boolean(api && token),
        token: token ?? '',
        baseUrl,
        subscription: eventSubscription,
        onConnect: handleSseConnect,
        onEvent: handleSseEvent,
    })

    // Loading auth source
    if (isAuthSourceLoading) {
        return (
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label="Loading…" className="text-sm" />
            </div>
        )
    }

    // No auth source (browser environment, not logged in)
    if (!authSource) {
        return (
            <LoginPrompt
                onLogin={setAccessToken}
                baseUrl={baseUrl}
                serverUrl={serverUrl}
                setServerUrl={setServerUrl}
                clearServerUrl={clearServerUrl}
            />
        )
    }

    // Authenticating (also covers the gap before useAuth effect starts)
    if (isAuthLoading || (authSource && !token && !authError)) {
        return (
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label="Authorizing…" className="text-sm" />
            </div>
        )
    }

    // Auth error
    if (authError || !token || !api) {
        // If using access token and auth failed, show login again
        if (authSource.type === 'accessToken') {
            return (
                <LoginPrompt
                    onLogin={setAccessToken}
                    baseUrl={baseUrl}
                    serverUrl={serverUrl}
                    setServerUrl={setServerUrl}
                    clearServerUrl={clearServerUrl}
                    error={authError ?? 'Authentication failed'}
                />
            )
        }

        // Telegram auth failed
        return (
            <div className="p-4 space-y-3">
                <div className="text-base font-semibold">Hapi</div>
                <div className="text-sm text-red-600">
                    {authError ?? 'Not authorized'}
                </div>
                <div className="text-xs text-[var(--app-hint)]">
                    Open this page from Telegram using the bot's "Open App" button (not "Open in browser").
                </div>
            </div>
        )
    }

    return (
        <AppContextProvider value={{ api, token }}>
            <SyncingBanner isSyncing={isSyncing} />
            <OfflineBanner />
            <div className="h-full flex flex-col">
                <Outlet />
            </div>
            <InstallPrompt />
        </AppContextProvider>
    )
}
