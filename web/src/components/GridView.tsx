import { useState, useCallback, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useGlobalKeyboard } from '@/hooks/useGlobalKeyboard'
import { SessionSearchModal } from '@/components/SessionSearchModal'
import type { Session } from '@/types/api'

function getSessionTitle(session: Session): string {
    if (session.metadata?.name) return session.metadata.name
    if ((session.metadata as any)?.summary?.text) return (session.metadata as any).summary.text
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

function getSessionFolder(session: Session): string {
    const path = (session.metadata as any)?.worktree?.basePath ?? session.metadata?.path ?? ''
    if (!path) return ''
    const parts = path.split('/').filter(Boolean)
    if (parts.length <= 1) return parts[0] ?? ''
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

function GridIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
        </svg>
    )
}

function BackIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function CloseIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    )
}

type Props = {
    sessions: Session[]
    baseUrl: string
    token: string
}

export function GridView({ sessions, baseUrl, token }: Props) {
    const navigate = useNavigate()
    const [pinnedIds, setPinnedIds] = useState<string[]>(() =>
        sessions.filter(s => s.active).slice(0, 4).map(s => s.id)
    )
    const [expandedId, setExpandedId] = useState<string | null>(null)
    const [focusedIdx, setFocusedIdx] = useState<number | null>(null)
    const [isAddOpen, setIsAddOpen] = useState(false)
    const [isReplaceOpen, setIsReplaceOpen] = useState(false)
    const [replaceTargetIdx, setReplaceTargetIdx] = useState<number | null>(null)
    const [stripMode, setStripMode] = useState(false)
    const iframeRefs = useRef<(HTMLIFrameElement | null)[]>([])

    // ── mutable ref holding latest actions ──────────────────────────────────
    // setupIframeKeyboard is registered once per iframe (onLoad); it would
    // capture stale closures if we used callbacks directly. Instead we read
    // actionsRef.current so the handler always sees fresh state.
    const actionsRef = useRef({
        focusIframe: (_n: number) => {},
        moveFocus: (_dir: 'h' | 'j' | 'k' | 'l') => {},
        toggleStrip: () => {},
        goBack: () => {},
        openAddModal: () => {},
        openReplaceModal: () => {},
        closeCurrentCell: () => {},
    })

    // Rebuild actionsRef on every render so it always closes over current state
    actionsRef.current = {
        focusIframe(n: number) {
            const idx = n - 1
            const iframe = iframeRefs.current[idx]
            if (!iframe) return
            setFocusedIdx(idx)
            try {
                iframe.contentWindow?.focus()
                const textarea = iframe.contentDocument?.querySelector('textarea')
                textarea?.focus()
            } catch { iframe.focus() }
        },
        toggleStrip() { setStripMode(prev => !prev) },
        goBack() { navigate({ to: '/sessions' }) },
        moveFocus(dir: 'h' | 'j' | 'k' | 'l') {
            const total = pinnedIds.length
            if (total === 0) return
            const current = focusedIdx ?? 0
            // Effective cols for navigation: treat 5-panel as 3-col
            const navCols = total <= 1 ? 1 : total === 3 ? 3 : total <= 4 ? 2 : total === 5 ? 3 : 3
            let next = current
            if (dir === 'h') next = current % navCols > 0 ? current - 1 : current
            else if (dir === 'l') next = current % navCols < navCols - 1 && current + 1 < total ? current + 1 : current
            else if (dir === 'k') next = current - navCols >= 0 ? current - navCols : (current - 1 + total) % total
            else if (dir === 'j') next = current + navCols < total ? current + navCols : (current + 1) % total
            if (next !== current) actionsRef.current.focusIframe(next + 1)
        },
        openAddModal() {
            setIsAddOpen(true)
        },
        // idx: explicit index from iframe handler (-1 = unknown, fall back to focusedIdx)
        openReplaceModal(idx?: number) {
            const target = idx !== undefined && idx >= 0 ? idx : focusedIdx
            setReplaceTargetIdx(target)
            setIsReplaceOpen(true)
        },
        closeCell(idx?: number) {
            const target = idx !== undefined && idx >= 0 ? idx : focusedIdx
            if (target === null || target === undefined) return
            const id = pinnedIds[target]
            if (!id) return
            setPinnedIds(prev => prev.filter(p => p !== id))
            setExpandedId(prev => prev === id ? null : prev)
            setFocusedIdx(null)
        },
    }
    // ────────────────────────────────────────────────────────────────────────

    const addSession = useCallback((id: string) => {
        setPinnedIds(prev => prev.includes(id) ? prev : [...prev.slice(-5), id])
    }, [])

    const removeSession = useCallback((id: string) => {
        setPinnedIds(prev => prev.filter(p => p !== id))
        setExpandedId(prev => prev === id ? null : prev)
        setFocusedIdx(null)
    }, [])

    const replaceCell = useCallback((session: Session) => {
        if (replaceTargetIdx === null) {
            addSession(session.id)
            return
        }
        setPinnedIds(prev => {
            const next = [...prev]
            next[replaceTargetIdx] = session.id
            return next
        })
        setFocusedIdx(replaceTargetIdx)
        setReplaceTargetIdx(null)
    }, [replaceTargetIdx, addSession])

    // Inject keyboard listener into iframe — uses actionsRef so no stale closures.
    // setupIframeKeyboard itself has no deps and is stable forever.
    const setupIframeKeyboard = useCallback((iframe: HTMLIFrameElement) => {
        const win = iframe.contentWindow
        if (!win) return

        const handler = (e: KeyboardEvent) => {
            // Alt+h/j/k/l — move focus between grid cells (vim-style)
            if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
                const dir = e.code === 'KeyH' ? 'h' : e.code === 'KeyJ' ? 'j' : e.code === 'KeyK' ? 'k' : e.code === 'KeyL' ? 'l' : null
                if (dir) { e.preventDefault(); e.stopPropagation(); actionsRef.current.moveFocus(dir as 'h'|'j'|'k'|'l'); return }
            }
            if (!e.metaKey) return
            // Resolve which cell this iframe is — used for replace/close
            const myIdx = iframeRefs.current.findIndex(ref => ref?.contentWindow === win)
            // Cmd+; — go back to sessions list
            if (e.key === ';' && !e.shiftKey) {
                e.preventDefault(); e.stopPropagation()
                actionsRef.current.goBack()
                return
            }
            // Cmd+' — toggle strip/grid layout
            if (e.key === "'" && !e.shiftKey) {
                e.preventDefault(); e.stopPropagation()
                actionsRef.current.toggleStrip()
                return
            }
            // Cmd+K — add session to grid
            if ((e.key === 'k' || e.key === 'K') && !e.shiftKey) {
                e.preventDefault(); e.stopPropagation()
                actionsRef.current.openAddModal()
                return
            }
            // Cmd+Shift+F — replace THIS cell
            if ((e.key === 'f' || e.key === 'F') && e.shiftKey) {
                e.preventDefault(); e.stopPropagation()
                actionsRef.current.openReplaceModal(myIdx)
                return
            }
            // Cmd+Shift+X — close THIS cell
            if ((e.key === 'x' || e.key === 'X') && e.shiftKey) {
                e.preventDefault(); e.stopPropagation()
                actionsRef.current.closeCell(myIdx)
                return
            }
            // Cmd+1-9 — focus nth grid cell
            const n = parseInt(e.key)
            if (n >= 1 && n <= 9) {
                e.preventDefault(); e.stopPropagation()
                actionsRef.current.focusIframe(n)
            }
        }

        win.addEventListener('keydown', handler, true)
        return () => win.removeEventListener('keydown', handler, true)
    }, []) // stable — reads actionsRef.current at call time

    // Parent-frame shortcuts (fires when parent has focus, not inside an iframe)
    useGlobalKeyboard(sessions, {
        onSelectIndex: (n) => actionsRef.current.focusIframe(n),
        onOpenSearch: () => actionsRef.current.openAddModal(),
        onReplaceCell: () => actionsRef.current.openReplaceModal(),
        onCloseCell: () => actionsRef.current.closeCell(),
        onMoveFocus: (dir) => actionsRef.current.moveFocus(dir),
        onToggleStrip: () => actionsRef.current.toggleStrip(),
    })

    const pinned = pinnedIds.map(id => sessions.find(s => s.id === id)).filter(Boolean) as Session[]
    const unpinned = sessions.filter(s => !pinnedIds.includes(s.id))

    // Strip mode: all panels in one row; otherwise adaptive grid
    const isFiveLayout = !stripMode && pinned.length === 5
    const cols = stripMode
        ? pinned.length || 1
        : pinned.length <= 1 ? 1 : pinned.length === 3 ? 3 : pinned.length <= 4 ? 2 : isFiveLayout ? 6 : 3
    const rows = stripMode ? 1 : isFiveLayout ? 2 : Math.ceil(pinned.length / cols)

    // Column span per item index for the 5-panel layout (not used in strip mode)
    const getColSpan = (i: number) => isFiveLayout ? (i < 3 ? 2 : 3) : 1

    const iframeUrl = (sessionId: string) => `/sessions/${sessionId}`

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--app-bg)', position: 'relative' }}>
            {/* Header */}
            <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
                borderBottom: '1px solid var(--app-border)', flexShrink: 0,
                paddingTop: 'calc(6px + env(safe-area-inset-top))'
            }}>
                <button
                    onClick={() => navigate({ to: '/sessions' })}
                    style={{ display: 'flex', alignItems: 'center', padding: 4, borderRadius: 6,
                        color: 'var(--app-hint)', background: 'none', border: 'none', cursor: 'pointer' }}
                    title="Back (Cmd+;)"
                >
                    <BackIcon />
                </button>
                <GridIcon />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--app-fg)' }}>Grid View</span>
                <span style={{ fontSize: 11, color: 'var(--app-hint)', marginLeft: 2 }}>
                    ⌘; back · ⌘K add · ⌘⇧F replace · ⌘⇧X close · ⌘1-{Math.min(pinned.length || 9, 9)} focus · ⌥hjkl move · ⌘' {stripMode ? 'grid' : 'strip'}
                </span>

                {unpinned.length > 0 && pinnedIds.length < 6 && (
                    <select
                        onChange={e => { if (e.target.value) { addSession(e.target.value); e.target.value = '' } }}
                        style={{ marginLeft: 'auto', fontSize: 12, padding: '3px 8px',
                            background: 'var(--app-secondary-bg)', border: '1px solid var(--app-border)',
                            borderRadius: 6, color: 'var(--app-fg)', cursor: 'pointer', maxWidth: 200 }}
                        defaultValue=""
                    >
                        <option value="" disabled>+ Add session</option>
                        {unpinned.map(s => (
                            <option key={s.id} value={s.id}>
                                {getSessionTitle(s)}{getSessionFolder(s) ? ` — ${getSessionFolder(s)}` : ''}
                            </option>
                        ))}
                    </select>
                )}
            </div>

            {/* Grid body */}
            {pinned.length === 0 ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                    justifyContent: 'center', gap: 12, color: 'var(--app-hint)', fontSize: 14 }}>
                    <GridIcon />
                    <span>No sessions pinned.</span>
                    {sessions.length > 0 && (
                        <span style={{ fontSize: 12 }}>Use "+ Add session" or ⌘K to pin sessions to the grid.</span>
                    )}
                </div>
            ) : expandedId ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 8px',
                        background: 'var(--app-secondary-bg)', borderBottom: '1px solid var(--app-border)', flexShrink: 0 }}>
                        <button onClick={() => setExpandedId(null)}
                            style={{ fontSize: 12, padding: '2px 10px', borderRadius: 4,
                                background: 'none', border: '1px solid var(--app-border)',
                                color: 'var(--app-fg)', cursor: 'pointer' }}>
                            ← Grid
                        </button>
                        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--app-fg)' }}>
                            {getSessionTitle(sessions.find(s => s.id === expandedId)!)}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--app-hint)' }}>
                            {getSessionFolder(sessions.find(s => s.id === expandedId)!)}
                        </span>
                    </div>
                    <iframe
                        src={iframeUrl(expandedId)}
                        style={{ flex: 1, border: 'none', minHeight: 0 }}
                        allow="microphone"
                    />
                </div>
            ) : (
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${cols}, 1fr)`,
                    gridTemplateRows: `repeat(${rows}, 1fr)`,
                    gap: 4, flex: 1, minHeight: 0, padding: 4
                }}>
                    {pinned.map((session, i) => {
                        const isFocused = focusedIdx === i
                        return (
                        <div key={session.id}
                            onClick={() => actionsRef.current.focusIframe(i + 1)}
                            style={{ position: 'relative', overflow: 'hidden', minHeight: 0,
                                gridColumn: getColSpan(i) > 1 ? `span ${getColSpan(i)}` : undefined,
                                border: isFocused ? '2px solid var(--app-link)' : '1px solid var(--app-border)',
                                borderRadius: 8, transition: 'border-color 0.15s' }}>

                            {/* Floating pill — right-aligned */}
                            <div className="grid-cell-overlay" style={{
                                position: 'absolute', top: 5, right: 5, zIndex: 10,
                                display: 'inline-flex', alignItems: 'center', gap: 5,
                                maxWidth: 'calc(100% - 10px)',
                                padding: '3px 6px 3px 8px',
                                background: 'rgba(0,0,0,0.5)',
                                backdropFilter: 'blur(8px)',
                                WebkitBackdropFilter: 'blur(8px)',
                                borderRadius: 8,
                                border: '1px solid rgba(255,255,255,0.06)',
                            }}>
                                {session.active && (
                                    <div style={{ width: 5, height: 5, borderRadius: '50%',
                                        background: '#34c759', flexShrink: 0 }} />
                                )}
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#fff',
                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {getSessionTitle(session)}
                                    </div>
                                    <div style={{ fontSize: 10, color: '#fff',
                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {[session.metadata?.flavor, getSessionFolder(session)].filter(Boolean).join(' · ')}
                                    </div>
                                </div>
                                <button onClick={e => { e.stopPropagation(); removeSession(session.id) }}
                                    title="Remove (⌘⇧X)"
                                    style={{ background: 'none', border: 'none', cursor: 'pointer',
                                        color: 'rgba(255,255,255,0.4)', padding: '0 2px', borderRadius: 3,
                                        display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                                    <CloseIcon />
                                </button>
                            </div>

                            {/* iframe fills the full cell */}
                            <iframe
                                ref={el => { iframeRefs.current[i] = el }}
                                src={iframeUrl(session.id)}
                                style={{ display: 'block', width: '100%', height: '100%',
                                    border: 'none', position: 'absolute', inset: 0 }}
                                allow="microphone"
                                onFocus={() => setFocusedIdx(i)}
                                onLoad={e => setupIframeKeyboard(e.currentTarget)}
                            />
                        </div>
                        )
                    })}
                </div>
            )}

            {/* Cmd+K: add new session to grid */}
            <SessionSearchModal
                sessions={sessions.filter(s => !pinnedIds.includes(s.id))}
                isOpen={isAddOpen}
                onClose={() => setIsAddOpen(false)}
                onSelect={s => addSession(s.id)}
                actionLabel="Add to grid"
            />

            {/* Cmd+Shift+F: replace focused cell */}
            <SessionSearchModal
                sessions={sessions}
                isOpen={isReplaceOpen}
                onClose={() => setIsReplaceOpen(false)}
                onSelect={replaceCell}
                actionLabel={replaceTargetIdx !== null ? `Replace ⌘${replaceTargetIdx + 1}` : 'Add to grid'}
            />
        </div>
    )
}
