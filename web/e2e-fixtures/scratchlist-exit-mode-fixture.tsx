/*
 * Playwright fixture for the scratchlist drawer interaction regression.
 * Mirrors ScratchlistDrawerHost behaviour without importing SessionChat
 * (which pulls the full app graph).
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { useScratchlist } from '../src/lib/use-scratchlist'
import { ScratchlistDrawer } from '../src/components/AssistantChat/ScratchlistPanel'
import type { ApiClient } from '../src/api/client'

declare global {
    interface Window {
        __scratchlistExitModeE2E?: {
            sessionId: string
            scratchlistMode: boolean
            queuedTexts: string[]
            queueSendMode: 'success' | 'failure'
        }
    }
}

function getInitialSessionId(): string {
    const url = new URL(window.location.href)
    return url.searchParams.get('session') ?? 'e2e-exit-mode'
}

function App() {
    const [sessionId] = React.useState(getInitialSessionId)
    const [scratchlistMode, setScratchlistMode] = React.useState(false)
    const scratchlist = useScratchlist(sessionId)
    const [queueSendMode, setQueueSendMode] = React.useState<'success' | 'failure'>('success')
    const [draft, setDraft] = React.useState('')
    const harnessData = React.useRef({
        queuedTexts: [] as string[],
        queueSendMode: 'success' as 'success' | 'failure',
    })
    const scratchlistModeRef = React.useRef(scratchlistMode)
    scratchlistModeRef.current = scratchlistMode
    harnessData.current.queueSendMode = queueSendMode

    React.useEffect(() => {
        window.__scratchlistExitModeE2E = {
            sessionId,
            get scratchlistMode() {
                return scratchlistModeRef.current
            },
            get queuedTexts() {
                return harnessData.current.queuedTexts
            },
            get queueSendMode() {
                return harnessData.current.queueSendMode
            },
        }
    }, [sessionId])

    const handleAdd = React.useCallback(() => {
        const added = scratchlist.add(draft)
        if (added) setDraft('')
    }, [draft, scratchlist])

    return (
        <I18nProvider>
            <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        aria-pressed={scratchlistMode ? true : false}
                        aria-label="Scratchlist drawer"
                        data-testid="scratchlist-mode-toggle"
                        onClick={() => setScratchlistMode((prev) => !prev)}
                        className="rounded border px-3 py-1.5 text-sm"
                    >
                        Scratchlist mode
                    </button>
                    <span
                        data-testid="composer-send-mode"
                        data-scratchlist-routing={scratchlistMode ? 'active' : 'inactive'}
                        className="rounded border px-2 py-1 text-xs"
                    >
                        Send routing: {scratchlistMode ? 'scratchlist' : 'chat'}
                    </span>
                    <label className="flex items-center gap-1 text-xs">
                        Queue mode
                        <select
                            aria-label="Queue send mode"
                            value={queueSendMode}
                            onChange={(event) => {
                                setQueueSendMode(event.target.value as 'success' | 'failure')
                            }}
                        >
                            <option value="success">success</option>
                            <option value="failure">failure</option>
                        </select>
                    </label>
                </div>

                {scratchlistMode ? (
                    <ScratchlistDrawer
                        entries={scratchlist.entries}
                        onUpdate={scratchlist.update}
                        onReorder={scratchlist.reorder}
                        onDelete={scratchlist.remove}
                        sessionId={sessionId}
                        api={{} as ApiClient}
                    />
                ) : null}

                <div className="flex gap-2">
                    <input
                        aria-label="Add scratchlist entry"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault()
                                handleAdd()
                            }
                        }}
                        className="flex-1 rounded border px-2 py-1 text-sm"
                        placeholder="Note — Enter to add"
                    />
                    <button type="button" onClick={handleAdd} className="rounded border px-3 py-1 text-sm">
                        Add
                    </button>
                </div>
            </div>
        </I18nProvider>
    )
}

const rootEl = document.getElementById('root')
if (rootEl) {
    ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    )
}
