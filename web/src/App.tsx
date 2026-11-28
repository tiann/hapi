import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Outlet, useLocation, useMatchRoute, useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { getTelegramWebApp, isTelegramApp } from '@/hooks/useTelegram'
import { initializeChatSurfaceColors } from '@/hooks/useChatSurfaceColors'
import { initializeTheme } from '@/hooks/useTheme'
import { initializeThemeColors } from '@/hooks/useThemeColors'
import { useAuth } from '@/hooks/useAuth'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { authConnectionMessage } from '@/lib/authConnection'
import { useAuthSource } from '@/hooks/useAuthSource'
import { useServerUrl } from '@/hooks/useServerUrl'
import { useSSE } from '@/hooks/useSSE'
import { useDelayedFlag } from '@/hooks/useDelayedFlag'
import { useSessions } from '@/hooks/queries/useSessions'
import { useReconnectingState } from '@/hooks/useReconnectingState'
import { useSyncingState } from '@/hooks/useSyncingState'
import { pushNotificationsDisabled, usePushNotifications } from '@/hooks/usePushNotifications'
import { useViewportHeight } from '@/hooks/useViewportHeight'
import { useVisibilityReporter } from '@/hooks/useVisibilityReporter'
import { getAppSseResyncQueryKeys } from '@/lib/sseResync'
import { refreshAllAgyCatalogs } from '@/lib/agyCatalogAnnouncement'
import { AppContextProvider } from '@/lib/app-context'
import { clearMessageWindow, recoverWindowAfterGapResume, rewindMessageWindow, syncTailMessages } from '@/lib/message-window-store'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useTranslation } from '@/lib/use-translation'
import { translateIncomingToast } from '@/lib/incoming-toast'
import { VoiceProvider } from '@/lib/voice-context'
import { requireHubUrlForLogin } from '@/lib/runtime-config'
import { getAppGlobalSseSubscription, getAppSessionSseSubscription } from '@/lib/appSseSubscriptions'
import { canUseAppBadging, useAppBadge } from '@/hooks/useAppBadge'
import { useAppBadgePreference } from '@/hooks/useAppBadgePreference'
import { reconcileQueuedStateAfterConnect } from '@/lib/queued-state-reconciliation'
import { LoginPrompt } from '@/components/LoginPrompt'
import { InstallPrompt } from '@/components/InstallPrompt'
import { OfflineBanner } from '@/components/OfflineBanner'
import { PwaUpdateBanner, PwaUpdateBannerWithStatusOffset } from '@/components/PwaUpdateBanner'
import { SyncingBanner } from '@/components/SyncingBanner'
import { ReconnectingBanner } from '@/components/ReconnectingBanner'
import { VoiceErrorBanner } from '@/components/VoiceErrorBanner'
import { RunnerVersionSkewBanner } from '@/components/RunnerVersionSkewBanner'
import { LoadingState } from '@/components/LoadingState'
import { ToastContainer } from '@/components/ToastContainer'
import { PwaUpdateProvider } from '@/lib/pwa-update-context'
import { ToastProvider, useAddToast } from '@/lib/toast-context'
import { getNotificationClickHref, NOTIFICATION_CLICK_ACK_TYPE } from '@/lib/notificationClick'
import type { SyncEvent } from '@/types/api'

type ToastEvent = Extract<SyncEvent, { type: 'toast' }>

const REQUIRE_SERVER_URL = requireHubUrlForLogin()
/** Matches the native apps: transient connection states show after 2s. */
const CONNECTION_STATUS_DELAY_MS = 2_000

function withPwaBanner(content: ReactNode) {
    return (
        <>
            <PwaUpdateBanner />
            {content}
        </>
    )
}

export function App() {
    return (
        <ToastProvider>
            <PwaUpdateProvider>
                <AppInner />
            </PwaUpdateProvider>
        </ToastProvider>
    )
}

function AppInner() {
    const { t } = useTranslation()
    const { serverUrl, baseUrl, setServerUrl, clearServerUrl } = useServerUrl()
    const { authSource, isLoading: isAuthSourceLoading, setAccessToken, setPasskeySession, clearAuth } = useAuthSource(baseUrl)
    const { token, api, isLoading: isAuthLoading, error: authError, needsBinding, connectionError, retryConnection, cancelRecovery, bind, handleSseClosed } = useAuth(authSource, baseUrl)
    const isOnline = useOnlineStatus()
    const connectionMessage = connectionError ? authConnectionMessage(connectionError, isOnline) : null
    const [titleSuggestionAvailable, setTitleSuggestionAvailable] = useState(false)
    const goBack = useAppGoBack()
    const pathname = useLocation({ select: (location) => location.pathname })
    const matchRoute = useMatchRoute()
    const router = useRouter()
    const addToast = useAddToast()

    useEffect(() => {
        let cancelled = false
        setTitleSuggestionAvailable(false)
        if (!api) return () => { cancelled = true }

        void api.getHealth()
            .then((health) => {
                if (!cancelled) {
                    setTitleSuggestionAvailable(health.capabilities?.titleSuggestion === true)
                }
            })
            .catch(() => {
                if (!cancelled) setTitleSuggestionAvailable(false)
            })

        return () => {
            cancelled = true
        }
    }, [api])

    useEffect(() => {
        const tg = getTelegramWebApp()
        tg?.ready()
        tg?.expand()
        initializeTheme()
        initializeThemeColors()
        initializeChatSurfaceColors()
    }, [])

    useEffect(() => {
        if (!('serviceWorker' in navigator)) {
            return
        }

        const handleServiceWorkerMessage = (event: MessageEvent<unknown>) => {
            const href = getNotificationClickHref(event.data, window.location.origin)
            if (!href) return
            const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`
            if (currentHref !== href) {
                router.history.push(href)
            }
            event.ports[0]?.postMessage({ type: NOTIFICATION_CLICK_ACK_TYPE })
        }

        navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage)
        return () => {
            navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage)
        }
    }, [router])

    // Track visual viewport height for mobile keyboard avoidance (see useViewportHeight.ts)
    useViewportHeight()

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
    const selectedSessionId = sessionMatch && sessionMatch.sessionId !== 'new' ? sessionMatch.sessionId : null
    const { isSyncing, startSync, endSync } = useSyncingState()
    const {
        isReconnecting: sseDisconnected,
        reason: sseDisconnectReason,
        reportConnect: reportSseConnect,
        reportDisconnect: reportSseDisconnect
    } = useReconnectingState()
    const syncTokenRef = useRef(0)
    const isFirstConnectRef = useRef(true)
    const baseUrlRef = useRef(baseUrl)
    const pushPromptedRef = useRef(false)
    const { appBadgeEnabled: appBadgePreferenceEnabled } = useAppBadgePreference()
    const appBadgeEnabled = Boolean(api && token && appBadgePreferenceEnabled && canUseAppBadging())
    const {
        sessions: appBadgeSessions,
        isLoading: appBadgeSessionsLoading,
        error: appBadgeSessionsError,
    } = useSessions(api, { enabled: appBadgeEnabled })
    useAppBadge({
        enabled: appBadgeEnabled,
        scope: baseUrl,
        sessions: appBadgeSessions,
        isLoading: appBadgeSessionsLoading,
        hasError: Boolean(appBadgeSessionsError),
    })
    const { isSupported: isPushSupported, permission: pushPermission, subscribe } = usePushNotifications(api)

    useEffect(() => {
        if (baseUrlRef.current === baseUrl) {
            return
        }
        baseUrlRef.current = baseUrl
        isFirstConnectRef.current = true
        syncTokenRef.current = 0
        queryClient.clear()
    }, [baseUrl, queryClient])

    const clearSignInUrl = useCallback((dropLaunchData = false) => {
        const cleanParams = (value: string, prefix: '?' | '#') => {
            const params = new URLSearchParams(value.slice(1))
            let changed = false
            for (const key of [...params.keys()]) {
                if (['token', 'server', 'hub'].includes(key) || dropLaunchData && (key === 'initData' || key === 'startapp' || key.startsWith('tgWebApp'))) {
                    params.delete(key); changed = true
                }
            }
            const cleaned = params.toString()
            return changed ? cleaned ? prefix + cleaned : '' : value
        }
        const { pathname, search, hash, state } = router.history.location
        const browserUrl = new URL(window.location.href)
        const nextHref = pathname + cleanParams(search, '?') + (dropLaunchData ? cleanParams(hash, '#') : hash)
        const browserHref = browserUrl.pathname + cleanParams(browserUrl.search, '?') + (dropLaunchData ? cleanParams(browserUrl.hash, '#') : browserUrl.hash)
        if (nextHref !== pathname + search + hash) router.history.replace(nextHref, state)
        // Telegram bootstrap may use memory history; auth reads the real URL.
        if (browserHref !== browserUrl.pathname + browserUrl.search + browserUrl.hash) window.history.replaceState(window.history.state, '', browserHref)
    }, [router])
    // Clean up direct access links after success or an explicit abandoned recovery.
    useEffect(() => { if (token && api) clearSignInUrl() }, [token, api, clearSignInUrl])
    const abandonRecovery = useCallback(() => {
        if (authSource?.type === 'telegram' || isTelegramApp()) return
        cancelRecovery()
        clearAuth()
        clearSignInUrl(true)
    }, [authSource, cancelRecovery, clearSignInUrl, clearAuth])

    useEffect(() => {
        if (!api || !token) {
            pushPromptedRef.current = false
            return
        }
        if (isTelegramApp() || !isPushSupported) {
            return
        }
        if (pushPromptedRef.current) {
            return
        }
        pushPromptedRef.current = true

        const run = async () => {
            if (pushPermission === 'granted' && !pushNotificationsDisabled()) {
                await subscribe()
            }
        }

        void run()
    }, [api, isPushSupported, pushPermission, subscribe, token])

    const handleSseConnect = useCallback((info: { resumed: boolean }) => {
        // Clear disconnected state on successful connection
        reportSseConnect()

        const isFirstConnect = isFirstConnectRef.current
        const invalidationKeys = getAppSseResyncQueryKeys(info, isFirstConnect)

        // The hub replayed every event missed during the gap, so the caches
        // are already consistent - the full refetch below would only re-download
        // what the replay just delivered. First connects and long gaps arrive
        // with resumed=false and take the resync path.
        if (invalidationKeys.length === 0) {
            return
        }

        // Increment token to track this specific connection
        const token = ++syncTokenRef.current

        // Only force show banner on first connect (page load)
        // Subsequent connects (session switches) use non-forced mode
        // which only shows banner when returning from background
        if (isFirstConnect) {
            isFirstConnectRef.current = false
            startSync({ force: true })
        } else {
            startSync()
        }
        const invalidations = [
            ...invalidationKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
            refreshAllAgyCatalogs(queryClient)
        ]
        const refreshMessages = (selectedSessionId && api)
            ? recoverWindowAfterGapResume(api, selectedSessionId)
            : Promise.resolve()
        Promise.all([...invalidations, refreshMessages])
            .catch((error) => {
                console.error('Failed to invalidate queries on SSE connect:', error)
            })
            .finally(() => {
                // Only end sync if this is still the latest connection
                if (syncTokenRef.current === token) {
                    endSync()
                }
            })
    }, [api, queryClient, selectedSessionId, startSync, endSync, reportSseConnect])

    const handleSseDisconnect = useCallback((reason: string) => {
        // Only show reconnecting banner if we've already connected once
        if (!isFirstConnectRef.current) {
            reportSseDisconnect(reason)
        }
        if (reason === 'closed') {
            handleSseClosed()
        }
    }, [handleSseClosed, reportSseDisconnect])

    const handleSseEvent = useCallback((event: SyncEvent) => {
        if (event.type !== 'messages-invalidated') {
            return
        }
        if (!api || event.sessionId !== selectedSessionId) {
            return
        }
        if (event.reason === 'rewind' && event.truncateFromLocalId) {
            rewindMessageWindow(event.sessionId, event.truncateFromLocalId)
        } else {
            clearMessageWindow(event.sessionId)
        }
        void syncTailMessages(api, event.sessionId)
    }, [api, selectedSessionId])

    const handleSessionSseConnect = useCallback((info: { resumed: boolean }) => {
        if (!api || !selectedSessionId) {
            return
        }
        // A resumed connection replayed messages-consumed/message events for
        // this session, so the queued-state snapshot cannot have drifted.
        if (info.resumed) {
            return
        }
        // First connects and gaps cannot prove continuity: reconcile the window
        // from an authoritative latest page (applied by id, keeping loaded
        // history) so in-place row updates (merged tool-call ticks) the replay
        // cannot deliver are recovered too.
        recoverWindowAfterGapResume(api, selectedSessionId).catch((error) => {
            console.error('Failed to recover the message window after an SSE gap:', error)
        })
        void reconcileQueuedStateAfterConnect(api, selectedSessionId).catch((error) => {
            console.error('Failed to reconcile queued state after SSE connect:', error)
        })
    }, [api, selectedSessionId])

    const handleToast = useCallback((event: ToastEvent) => {
        const localized = translateIncomingToast(event.data.title, event.data.body, t)
        addToast({
            title: localized.title,
            body: localized.body,
            sessionId: event.data.sessionId,
            url: event.data.url
        })
    }, [addToast, t])

    const globalEventSubscription = useMemo(() => getAppGlobalSseSubscription(), [])
    const sessionEventSubscription = useMemo(
        () => getAppSessionSseSubscription(selectedSessionId),
        [selectedSessionId]
    )
    const sseEnabled = Boolean(api && token)

    const { subscriptionId: globalSubscriptionId } = useSSE({
        enabled: sseEnabled,
        token: token ?? '',
        baseUrl,
        subscription: globalEventSubscription,
        scope: 'global',
        hubClock: api?.hubClock,
        onConnect: handleSseConnect,
        onDisconnect: handleSseDisconnect,
        onEvent: () => {},
        onToast: handleToast
    })

    const { subscriptionId: sessionSubscriptionId } = useSSE({
        enabled: sseEnabled && Boolean(sessionEventSubscription),
        token: token ?? '',
        baseUrl,
        subscription: sessionEventSubscription ?? undefined,
        scope: 'full',
        onConnect: handleSessionSseConnect,
        onEvent: handleSseEvent
    })

    const streamConnected = globalSubscriptionId !== null
    const showReconnectingBanner = !streamConnected && !isSyncing && (Boolean(connectionError) || sseDisconnected || !isOnline)
    const showAuthRefreshBanner = streamConnected && !isSyncing && isOnline && Boolean(connectionError)
    // Transient states wait before showing; quick reconnects never flash.
    const revealReconnecting = useDelayedFlag(showReconnectingBanner, CONNECTION_STATUS_DELAY_MS)
    const revealAuthRefresh = useDelayedFlag(showAuthRefreshBanner, CONNECTION_STATUS_DELAY_MS)
    const [connectionBannerHeight, setConnectionBannerHeight] = useState(0)
    const revealSyncing = useDelayedFlag(isSyncing, CONNECTION_STATUS_DELAY_MS)

    useVisibilityReporter({
        api,
        subscriptionId: globalSubscriptionId,
        enabled: sseEnabled
    })

    useVisibilityReporter({
        api,
        subscriptionId: sessionSubscriptionId,
        enabled: sseEnabled && Boolean(sessionEventSubscription)
    })

    // Loading auth source
    if (isAuthSourceLoading) {
        return withPwaBanner(
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label={t('loading')} className="text-sm" />
            </div>,
        )
    }

    // No auth source (browser environment, not logged in)
    if (!authSource) {
        return withPwaBanner(
            <LoginPrompt
                onLogin={setAccessToken}
                onPasskeyLogin={setPasskeySession}
                baseUrl={baseUrl}
                serverUrl={serverUrl}
                setServerUrl={setServerUrl}
                clearServerUrl={clearServerUrl}
                requireServerUrl={REQUIRE_SERVER_URL}
            />,
        )
    }

    if (needsBinding) {
        return withPwaBanner(
            <LoginPrompt
                mode="bind"
                onBind={bind}
                baseUrl={baseUrl}
                serverUrl={serverUrl}
                setServerUrl={setServerUrl}
                clearServerUrl={clearServerUrl}
                requireServerUrl={REQUIRE_SERVER_URL}
                error={authError ?? undefined}
            />,
        )
    }

    if (connectionError && !token) {
        return withPwaBanner(
            <LoginPrompt
                mode="reconnect"
                onReconnect={retryConnection}
                onChooseHub={authSource.type === 'telegram' || isTelegramApp() ? undefined : abandonRecovery}
                error={connectionMessage}
                baseUrl={baseUrl}
                serverUrl={serverUrl}
                setServerUrl={setServerUrl}
                clearServerUrl={clearServerUrl}
                requireServerUrl={REQUIRE_SERVER_URL}
            />,
        )
    }

    // Authenticating (also covers the gap before useAuth effect starts)
    if (isAuthLoading || (authSource && !token && !authError)) {
        return withPwaBanner(
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label={t('authorizing')} className="text-sm" />
            </div>,
        )
    }

    // Auth error
    if (authError || !token || !api) {
        // If using an access token or passkey and auth failed, show login again
        if (authSource.type === 'accessToken' || authSource.type === 'passkey') {
            return withPwaBanner(
                <LoginPrompt
                    onLogin={setAccessToken}
                    onPasskeyLogin={setPasskeySession}
                    baseUrl={baseUrl}
                    serverUrl={serverUrl}
                    setServerUrl={setServerUrl}
                    clearServerUrl={clearServerUrl}
                    requireServerUrl={REQUIRE_SERVER_URL}
                    error={authError ?? t('login.error.authFailed')}
                />,
            )
        }

        // Telegram auth failed
        return withPwaBanner(
            <div className="p-4 space-y-3">
                <div className="text-base font-semibold">{t('login.title')}</div>
                <div className="text-sm text-red-600">
                    {authError ?? t('login.error.authFailed')}
                </div>
                <div className="text-xs text-[var(--app-hint)]">
                    Open this page from Telegram using the bot's "Open App" button (not "Open in browser").
                </div>
            </div>,
        )
    }

    return (
        <AppContextProvider value={{ api, token, baseUrl, titleSuggestionAvailable }}>
            <VoiceProvider>
                <SyncingBanner isSyncing={revealSyncing} />
                <ReconnectingBanner
                    isReconnecting={revealReconnecting && !streamConnected}
                    reason={!isOnline ? authConnectionMessage({}, false) : connectionMessage ?? sseDisconnectReason}
                    onHeightChange={setConnectionBannerHeight}
                />
                <ReconnectingBanner
                    isReconnecting={revealAuthRefresh && streamConnected}
                    message="Sign-in refresh failed. Chat updates may be delayed; retrying automatically."
                    onHeightChange={setConnectionBannerHeight}
                    reason={connectionError?.diagnostic ?? (connectionError?.status ? `HTTP ${connectionError.status}` : null)}
                />
                <VoiceErrorBanner />
                <OfflineBanner
                    isHubConnected={globalSubscriptionId !== null}
                    isReconnecting={showReconnectingBanner}
                />
                <div className="h-full min-h-0 flex flex-col" style={{
                    paddingTop: connectionBannerHeight,
                    '--route-safe-area-top': connectionBannerHeight ? '0px' : undefined
                } as CSSProperties}>
                    <PwaUpdateBannerWithStatusOffset
                        isSyncing={revealSyncing}
                        isReconnecting={revealReconnecting || revealAuthRefresh}
                        inStatusStack={connectionBannerHeight > 0}
                    />
                    <RunnerVersionSkewBanner inStatusStack={connectionBannerHeight > 0} />
                    <div className="flex min-h-0 flex-1 flex-col">
                        <Outlet />
                    </div>
                </div>
                <ToastContainer />
                <InstallPrompt />
            </VoiceProvider>
        </AppContextProvider>
    )
}
