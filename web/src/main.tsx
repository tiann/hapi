import { completePasskeyCallback } from '@/lib/passkey'
import { PASSKEY_CALLBACK_PATH } from '@hapi/protocol/passkey'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import './index.css'
import { initializeFontScale } from '@/hooks/useFontScale'
import { getTelegramWebApp, isTelegramEnvironment, loadTelegramSdk } from './hooks/useTelegram'
import { queryClient } from './lib/query-client'
import { createAppRouter } from './router'
import { I18nProvider } from './lib/i18n-context'
import { restoreSpaRedirect } from './lib/spaRedirect'
import { installScrollRestorationGuard } from './lib/scrollStorageGuard'
import { installTelemetry, TelemetryErrorBoundary } from './lib/telemetry'
import { resolveLiveBaseUrl } from './lib/telemetry/device'

// Telemetry SDK first (详细日志模式 P0): the authProxy fetch wrapper and the
// global error handlers must be in place before any render or hub request.
// dev builds are a complete no-op. The JWT only exists inside React (useAuth),
// so getAuthToken stays null here — the SDK learns the live Bearer token from
// the authProxy single fetch point (httpObserver.noteBearerFromHeaders) and
// re-resolves the hub baseUrl (?hub= > localStorage `hapi_hub_url` > origin)
// on every send, so a settings-side hub switch needs no reinstall.
installTelemetry({
    getAuthToken: () => null,
    baseUrl: resolveLiveBaseUrl(''),
})

function getStartParam(): string | null {
    const query = new URLSearchParams(window.location.search)
    const fromQuery = query.get('startapp') || query.get('tgWebAppStartParam')
    if (fromQuery) return fromQuery

    return getTelegramWebApp()?.initDataUnsafe?.start_param ?? null
}

function getDeepLinkedSessionId(): string | null {
    const startParam = getStartParam()
    if (startParam?.startsWith('session_')) {
        return startParam.slice('session_'.length)
    }
    return null
}

function getInitialPath(): string {
    const sessionId = getDeepLinkedSessionId()
    return sessionId ? `/sessions/${sessionId}` : '/sessions'
}

async function bootstrap() {
    installScrollRestorationGuard()
    initializeFontScale()

    // Only load Telegram SDK in Telegram environment (with 3s timeout)
    const isTelegram = isTelegramEnvironment()
    document.documentElement.dataset.telegramApp = isTelegram ? 'true' : 'false'
    if (isTelegram) {
        await loadTelegramSdk()
    }

    // Handle GitHub Pages 404 redirect for SPA routing
    // When GitHub Pages can't find a path (e.g. /sessions/xxx), it serves 404.html
    // which stores the path in sessionStorage and redirects to /
    if (!isTelegram) {
        restoreSpaRedirect()
    }

    const history = isTelegram
        ? createMemoryHistory({ initialEntries: [getInitialPath()] })
        : undefined
    const router = createAppRouter(history)

    ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
            <I18nProvider>
                <QueryClientProvider client={queryClient}>
                    <TelemetryErrorBoundary>
                        <RouterProvider router={router} />
                    </TelemetryErrorBoundary>
                    {import.meta.env.DEV ? <ReactQueryDevtools initialIsOpen={false} /> : null}
                </QueryClientProvider>
            </I18nProvider>
        </React.StrictMode>
    )
}

if (window.location.pathname === PASSKEY_CALLBACK_PATH) {
    completePasskeyCallback()
} else {
    bootstrap()
}
