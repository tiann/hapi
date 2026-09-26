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
 * The fixture intentionally mounts only the scratchlist surface so the
 * interaction tests do not need the full composer / queue graph.
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
 * Mirror of SessionChat's ScratchlistHost. The spec drives sessionId changes through
 * the parent (App), while this host either keys by sessionId
 * (production behaviour) or doesn't (pre-fix repro).
 */
function ScratchlistHost({ sessionId, keyed }: { sessionId: string; keyed: boolean }) {
    return (
        <ScratchlistPanel
            key={keyed ? sessionId : undefined}
            sessionId={sessionId}
        />
    )
}

function App() {
    const [sessionId, setSessionId] = React.useState<string>(() => getInitialSessionId())
    const keyed = React.useMemo(() => getKeyByedSessionId(), [])

    React.useEffect(() => {
        const harness: NonNullable<Window['__scratchlistE2E']> = {
            sessionId,
            keyByedSessionId: keyed,
            setSessionId: (id: string) => setSessionId(id),
            reset() {
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
