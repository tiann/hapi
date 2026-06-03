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
 * The fixture also exposes `window.__scratchlistE2E.setSessionId(id)`
 * so a spec can switch sessions WITHOUT a full page reload — this
 * reproduces the SessionChat pattern where the parent stays mounted
 * across same-route navigation. Used by the regression test for the
 * "stale entries leak from session A into session B" bug fixed in
 * `SessionChat.tsx` by keying the host by `session.id`.
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
            /** Whether the fixture's host wrapper applies `key={sessionId}`.
             * Mirrors the SessionChat fix; toggle via `?key=0` to repro the
             * pre-fix bug for red/green tests. Defaults to `true`. */
            keyByedSessionId: boolean
            setSessionId(id: string): void
            reset(): void
        }
    }
}

function getInitialSessionId(): string {
    const url = new URL(window.location.href)
    return url.searchParams.get('session') ?? 'e2e'
}

function getKeyByedSessionId(): boolean {
    const url = new URL(window.location.href)
    const raw = url.searchParams.get('key')
    if (raw === '0' || raw === 'false') return false
    return true
}

/*
 * Mirror of SessionChat's ScratchlistHost: a thin wrapper that owns
 * the promote callbacks. The spec drives sessionId changes through
 * the parent (App), while this host either keys by sessionId
 * (production behaviour) or doesn't (pre-fix repro).
 */
function ScratchlistHost({ sessionId, keyed }: { sessionId: string; keyed: boolean }) {
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
        <ScratchlistPanel
            key={keyed ? sessionId : undefined}
            sessionId={sessionId}
            onPromoteToComposer={handlePromoteToComposer}
            onPromoteToQueue={handlePromoteToQueue}
        />
    )
}

function App() {
    const [sessionId, setSessionId] = React.useState<string>(() => getInitialSessionId())
    const keyed = React.useMemo(() => getKeyByedSessionId(), [])

    React.useEffect(() => {
        const harness: NonNullable<Window['__scratchlistE2E']> = {
            sessionId,
            promotedToComposer: [],
            promotedToQueue: [],
            queueSendMode: 'success',
            keyByedSessionId: keyed,
            setSessionId: (id: string) => setSessionId(id),
            reset() {
                this.promotedToComposer = []
                this.promotedToQueue = []
                this.queueSendMode = 'success'
            },
        }
        window.__scratchlistE2E = harness
    }, [keyed])

    React.useEffect(() => {
        if (window.__scratchlistE2E) {
            window.__scratchlistE2E.sessionId = sessionId
        }
    }, [sessionId])

    return (
        <I18nProvider>
            <ScratchlistHost sessionId={sessionId} keyed={keyed} />
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
