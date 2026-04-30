import { useCallback } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useSessions } from '@/hooks/queries/useSessions'
import { DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import type { RootSearch } from '@/router'
import type { SessionSummary } from '@/types/api'

function getSessionTitle(session: SessionSummary): string {
    if (session.metadata?.name) return session.metadata.name
    if (session.metadata?.summary?.text) return session.metadata.summary.text.substring(0, 60)
    return `Session ${session.id.substring(0, 6)}`
}

function getAgentLabel(session: SessionSummary): string {
    const flavor = session.metadata?.flavor ?? 'claude'
    if (flavor === 'codex') return 'Codex'
    if (flavor === 'gemini') return 'Gemini'
    return 'Claude'
}

function PinIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="17" x2="12" y2="22" />
            <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
        </svg>
    )
}

export function ReplacePinModal(props: { onClose: () => void }) {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const { t } = useTranslation()
    const search = useSearch({ strict: false }) as RootSearch
    const { sessions } = useSessions(api)
    const newSessionId = search.modalSessionId

    // Read pins fresh — localStorage is source of truth
    let currentPins: string[] = []
    try {
        const saved = localStorage.getItem('mc-pinned-ids')
        if (saved) currentPins = JSON.parse(saved)
    } catch { /* ignore */ }
    // Fallback to URL
    if (currentPins.length === 0 && typeof (search as any).pins === 'string' && (search as any).pins) {
        currentPins = (search as any).pins.split(',')
    }

    const handleReplace = useCallback((pinIdToReplace: string) => {
        if (!newSessionId) {
            props.onClose()
            return
        }
        const newPins = currentPins.map(id => id === pinIdToReplace ? newSessionId : id)
        void navigate({
            to: '/sessions',
            search: (prev: any) => {
                const newSearch = { ...prev }
                delete newSearch.modal
                delete newSearch.modalSessionId
                return { ...newSearch, pins: newPins.join(','), modalNewSessionId: newSessionId }
            },
            replace: true
        })
    }, [currentPins, navigate, newSessionId, props])

    const handleSkip = useCallback(() => {
        void navigate({
            to: '/sessions',
            search: (prev: any) => {
                const newSearch = { ...prev }
                delete newSearch.modal
                delete newSearch.modalSessionId
                return { ...newSearch, modalNewSessionId: newSessionId }
            },
            replace: true
        })
    }, [navigate, newSessionId])

    const pinnedSessions = currentPins
        .map(id => sessions.find(s => s.id === id))
        .filter((s): s is SessionSummary => s !== undefined)

    return (
        <DialogContent className="flex flex-col max-h-[85vh] w-[95vw] max-w-lg p-0 gap-0 overflow-hidden">
            <DialogHeader className="p-4 pb-3 border-b border-[var(--app-border)]">
                <DialogTitle className="text-xl font-semibold">Maximum Pins Reached</DialogTitle>
                <DialogDescription className="text-sm text-[var(--app-hint)] mt-1">
                    You can only pin up to 4 sessions. Select a session below to replace it with your new session, or skip pinning.
                </DialogDescription>
            </DialogHeader>

            <div className="app-scroll-y p-4 flex flex-col gap-2">
                {pinnedSessions.map((s, index) => (
                    <button
                        key={s.id}
                        type="button"
                        onClick={() => handleReplace(s.id)}
                        className="flex items-center gap-3 w-full text-left p-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                    >
                        <div className="flex items-center justify-center w-6 h-6 rounded-full bg-[var(--app-subtle-bg)] text-[var(--app-hint)] text-xs font-semibold shrink-0">
                            {index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-[var(--app-fg)] truncate">
                                {getSessionTitle(s)}
                            </div>
                            <div className="text-xs text-[var(--app-hint)] flex items-center gap-2 mt-0.5">
                                <span className={`db-card__agent db-card__agent--${s.metadata?.flavor ?? 'claude'} !text-[10px] !px-1`}>
                                    {getAgentLabel(s)}
                                </span>
                            </div>
                        </div>
                        <PinIcon />
                    </button>
                ))}

                <button
                    type="button"
                    onClick={handleSkip}
                    className="mt-2 w-full p-2 text-center text-sm font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors rounded-lg hover:bg-[var(--app-subtle-bg)]"
                >
                    Skip Pinning
                </button>
            </div>
        </DialogContent>
    )
}
