import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLocation, useMatchRoute, useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { initializeTheme } from '@/shared/hooks/useTheme'
import { useAuth, useAuthSource } from '@/entities/auth'
import { useServerUrl } from '@/hooks/useServerUrl'
import { useSSE } from '@/hooks/useSSE'
import { useSyncingState } from '@/hooks/useSyncingState'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { useVisibilityReporter } from '@/hooks/useVisibilityReporter'
import { queryKeys } from '@/lib/query-keys'
import { AppContextProvider } from '@/lib/app-context'
import { fetchLatestMessages } from '@/lib/message-window-store'
import { useTranslation } from '@/lib/use-translation'
import { requireHubUrlForLogin } from '@/shared/lib/runtime-config'
import { LoginPrompt } from '@/entities/auth'
import { InstallPrompt } from '@/components/InstallPrompt'
import { OfflineBanner } from '@/components/OfflineBanner'
import { SyncingBanner } from '@/components/SyncingBanner'
import { ReconnectingBanner } from '@/components/ReconnectingBanner'
import { LoadingState } from '@/components/LoadingState'
import { ToastContainer } from '@/components/ToastContainer'
import { ToastProvider, useToast } from '@/lib/toast-context'
import type { SyncEvent } from '@/types/api'

type ToastEvent = Extract<SyncEvent, { type: 'toast' }>

const REQUIRE_SERVER_URL = requireHubUrlForLogin()

export function App() {
    return (
        <ToastProvider>
            <AppInner />
        </ToastProvider>
    )
}

function AppInner() {
    const { t } = useTranslation()
    const { serverUrl, baseUrl, setServerUrl, clearServerUrl } = useServerUrl()
    const { authSource, isLoading: isAuthSourceLoading, setAccessToken } = useAuthSource(baseUrl)
    const { token, api, isLoading: isAuthLoading, error: authError } = useAuth(authSource, baseUrl)
    const pathname = useLocation({ select: (location) => location.pathname })
    const matchRoute = useMatchRoute()
    const router = useRouter()
    const { addToast } = useToast()

    // 初始化主题
    useEffect(() => {
        initializeTheme()
    }, [])

    // 防止缩放手势
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

    const queryClient = useQueryClient()
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId' })
    const selectedSessionId = sessionMatch && sessionMatch.sessionId !== 'new' ? sessionMatch.sessionId : null
    const { isSyncing, startSync, endSync } = useSyncingState()
    const [sseDisconnected, setSseDisconnected] = useState(false)
    const [sseDisconnectReason, setSseDisconnectReason] = useState<string | null>(null)
    const syncTokenRef = useRef(0)
    const isFirstConnectRef = useRef(true)
    const baseUrlRef = useRef(baseUrl)
    const pushPromptedRef = useRef(false)
    const { isSupported: isPushSupported, permission: pushPermission, requestPermission, subscribe } = usePushNotifications(api)

    // 基础 URL 变更时重置状态
    useEffect(() => {
        if (baseUrlRef.current === baseUrl) {
            return
        }
        baseUrlRef.current = baseUrl
        isFirstConnectRef.current = true
        syncTokenRef.current = 0
        queryClient.clear()
    }, [baseUrl, queryClient])

    // 清理 URL 参数
    useEffect(() => {
        if (!token || !api) return
        const { pathname, search, hash, state } = router.history.location
        const searchParams = new URLSearchParams(search)
        if (!searchParams.has('server') && !searchParams.has('hub') && !searchParams.has('token')) {
            return
        }
        searchParams.delete('server')
        searchParams.delete('hub')
        searchParams.delete('token')
        const nextSearch = searchParams.toString()
        const nextHref = `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash}`
        router.history.replace(nextHref, state)
    }, [token, api, router])

    // 推送通知
    useEffect(() => {
        if (!api || !token) {
            pushPromptedRef.current = false
            return
        }
        if (!isPushSupported) {
            return
        }
        if (pushPromptedRef.current) {
            return
        }
        pushPromptedRef.current = true

        const run = async () => {
            if (pushPermission === 'granted') {
                await subscribe()
                return
            }
            if (pushPermission === 'default') {
                const granted = await requestPermission()
                if (granted) {
                    await subscribe()
                }
            }
        }

        void run()
    }, [api, isPushSupported, pushPermission, requestPermission, subscribe, token])

    // SSE 连接处理
    const handleSseConnect = useCallback(() => {
        setSseDisconnected(false)
        setSseDisconnectReason(null)

        const token = ++syncTokenRef.current

        if (isFirstConnectRef.current) {
            isFirstConnectRef.current = false
            startSync({ force: true })
        } else {
            startSync()
        }
        const invalidations = [
            queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
            ...(selectedSessionId ? [
                queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) })
            ] : [])
        ]
        const refreshMessages = (selectedSessionId && api)
            ? fetchLatestMessages(api, selectedSessionId)
            : Promise.resolve()
        Promise.all([...invalidations, refreshMessages])
            .catch((error) => {
                console.error('Failed to invalidate queries on SSE connect:', error)
            })
            .finally(() => {
                if (syncTokenRef.current === token) {
                    endSync()
                }
            })
    }, [api, queryClient, selectedSessionId, startSync, endSync])

    const handleSseDisconnect = useCallback((reason: string) => {
        if (!isFirstConnectRef.current) {
            setSseDisconnected(true)
            setSseDisconnectReason(reason)
        }
    }, [])

    const handleSseEvent = useCallback(() => {}, [])

    const handleToast = useCallback((event: ToastEvent) => {
        addToast({
            title: event.data.title,
            body: event.data.body,
            sessionId: event.data.sessionId,
            url: event.data.url
        })
    }, [addToast])

    const eventSubscription = useMemo(() => {
        if (selectedSessionId) {
            return { sessionId: selectedSessionId }
        }
        return { all: true }
    }, [selectedSessionId])

    const { subscriptionId } = useSSE({
        enabled: Boolean(api && token),
        token: token ?? '',
        baseUrl,
        subscription: eventSubscription,
        onConnect: handleSseConnect,
        onDisconnect: handleSseDisconnect,
        onEvent: handleSseEvent,
        onToast: handleToast
    })

    useVisibilityReporter({
        api,
        subscriptionId,
        enabled: Boolean(api && token)
    })

    // Loading auth source
    if (isAuthSourceLoading) {
        return (
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label={t('loading')} className="text-sm" />
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
                requireServerUrl={REQUIRE_SERVER_URL}
            />
        )
    }

    // Authenticating
    if (isAuthLoading || (authSource && !token && !authError)) {
        return (
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label={t('authorizing')} className="text-sm" />
            </div>
        )
    }

    // Auth error
    if (authError || !token || !api) {
        return (
            <LoginPrompt
                onLogin={setAccessToken}
                baseUrl={baseUrl}
                serverUrl={serverUrl}
                setServerUrl={setServerUrl}
                clearServerUrl={clearServerUrl}
                requireServerUrl={REQUIRE_SERVER_URL}
                error={authError ?? t('login.error.authFailed')}
            />
        )
    }

    return (
        <AppContextProvider value={{ api, token, baseUrl }}>
            <SyncingBanner isSyncing={isSyncing} />
            <ReconnectingBanner
                isReconnecting={sseDisconnected && !isSyncing}
                reason={sseDisconnectReason}
            />
            <OfflineBanner />
            <div className="h-full flex flex-col">
                <Outlet />
            </div>
            <ToastContainer />
            <InstallPrompt />
        </AppContextProvider>
    )
}
