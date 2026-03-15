import { useEffect } from 'react'
import { Outlet, useMatchRoute } from '@tanstack/react-router'
import { initializeTheme } from '@/shared/hooks/useTheme'
import { useAuthBootstrap } from '@/processes/auth-bootstrap'
import { useSessionSync } from '@/processes/session-sync'
import { AppContextProvider } from '@/lib/app-context'
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
    const { addToast } = useToast()

    // Initialize theme
    useEffect(() => {
        initializeTheme()
    }, [])

    // Disable browser zoom
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

    // Auth bootstrap process
    const {
        serverUrl,
        baseUrl,
        setServerUrl,
        clearServerUrl,
        authSource,
        isAuthSourceLoading,
        token,
        api,
        isAuthLoading,
        authError,
        setAccessToken
    } = useAuthBootstrap()

    // Get selected session ID
    const matchRoute = useMatchRoute()
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId' })
    const selectedSessionId = sessionMatch && sessionMatch.sessionId !== 'new' ? sessionMatch.sessionId : null

    // Session sync process
    const {
        isSyncing,
        sseDisconnected,
        sseDisconnectReason
    } = useSessionSync({
        enabled: Boolean(api && token),
        token: token ?? '',
        baseUrl,
        selectedSessionId,
        api,
        addToast
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

    // Authenticating (also covers the gap before useAuth effect starts)
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
