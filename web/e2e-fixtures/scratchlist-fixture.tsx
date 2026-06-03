/*
 * Standalone Vite-served fixture for the scratchlist Playwright e2e
 * spec. Mounts only the ScratchlistPanel inside an I18nProvider so the
 * spec can drive a real browser against the real component without
 * having to mock the entire HAPI auth + socket stack.
 *
 * The session id is read from the `?session=...` query param (default
 * `e2e`) so individual specs can isolate localStorage state simply by
 * navigating to a unique URL.
 *
 * Promote callbacks are exposed on `window.__scratchlistE2E` so the
 * spec can assert that the right text reached `setText` (composer)
 * and `onSend` (queue) without involving the real composer / queue.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { ScratchlistPanel } from '../src/components/AssistantChat/ScratchlistPanel'

declare global {
    interface Window {
        __scratchlistE2E?: {
            sessionId: string
            promotedToComposer: string[]
            promotedToQueue: string[]
            queueSendMode: 'success' | 'failure'
            reset(): void
        }
    }
}

function getSessionId(): string {
    const url = new URL(window.location.href)
    return url.searchParams.get('session') ?? 'e2e'
}

function App() {
    const sessionId = React.useMemo(() => getSessionId(), [])

    if (!window.__scratchlistE2E) {
        window.__scratchlistE2E = {
            sessionId,
            promotedToComposer: [],
            promotedToQueue: [],
            queueSendMode: 'success',
            reset() {
                this.promotedToComposer = []
                this.promotedToQueue = []
                this.queueSendMode = 'success'
            },
        }
    } else {
        window.__scratchlistE2E.sessionId = sessionId
    }

    const handlePromoteToComposer = React.useCallback((text: string) => {
        window.__scratchlistE2E?.promotedToComposer.push(text)
    }, [])

    const handlePromoteToQueue = React.useCallback(async (text: string) => {
        const harness = window.__scratchlistE2E
        if (!harness) return false
        if (harness.queueSendMode === 'failure') {
            return false
        }
        harness.promotedToQueue.push(text)
        return true
    }, [])

    return (
        <I18nProvider>
            <ScratchlistPanel
                sessionId={sessionId}
                onPromoteToComposer={handlePromoteToComposer}
                onPromoteToQueue={handlePromoteToQueue}
            />
        </I18nProvider>
    )
}

const rootEl = document.getElementById('root')
if (rootEl) {
    ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    )
}
