import { useState, useEffect, useRef, useMemo } from 'react'
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

type Props = {
    sessions: Session[]
    isOpen: boolean
    onClose: () => void
    onSelect: (session: Session) => void
    actionLabel?: string
}

export function SessionSearchModal({ sessions, isOpen, onClose, onSelect, actionLabel = 'Open' }: Props) {
    const [query, setQuery] = useState('')
    const [activeIdx, setActiveIdx] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLDivElement>(null)

    const filtered = useMemo(() => {
        if (!query.trim()) return sessions
        const q = query.toLowerCase()
        return sessions.filter(s => {
            const title = getSessionTitle(s).toLowerCase()
            const folder = getSessionFolder(s).toLowerCase()
            return title.includes(q) || folder.includes(q) || s.id.toLowerCase().startsWith(q)
        })
    }, [sessions, query])

    useEffect(() => {
        if (isOpen) {
            setQuery('')
            setActiveIdx(0)
            requestAnimationFrame(() => inputRef.current?.focus())
        }
    }, [isOpen])

    useEffect(() => { setActiveIdx(0) }, [query])

    // Scroll active item into view
    useEffect(() => {
        const el = listRef.current?.children[activeIdx] as HTMLElement | undefined
        el?.scrollIntoView({ block: 'nearest' })
    }, [activeIdx])

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActiveIdx(i => Math.min(i + 1, filtered.length - 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActiveIdx(i => Math.max(i - 1, 0))
        } else if (e.key === 'Enter') {
            e.preventDefault()
            const s = filtered[activeIdx]
            if (s) { onSelect(s); onClose() }
        }
    }

    if (!isOpen) return null

    return (
        <div
            style={{
                position: 'fixed', inset: 0, zIndex: 9999,
                background: 'rgba(0,0,0,0.45)',
                display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
                paddingTop: '12vh',
            }}
            onMouseDown={onClose}
        >
            <div
                style={{
                    width: '90%', maxWidth: 560,
                    background: 'var(--app-bg)',
                    border: '1px solid var(--app-border)',
                    borderRadius: 12,
                    boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
                    overflow: 'hidden',
                    display: 'flex', flexDirection: 'column',
                    maxHeight: '60vh',
                }}
                onMouseDown={e => e.stopPropagation()}
            >
                {/* Input row */}
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px',
                    borderBottom: filtered.length > 0 ? '1px solid var(--app-border)' : 'none',
                }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                        stroke="var(--app-hint)" strokeWidth="2.5" strokeLinecap="round">
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Search sessions…"
                        style={{
                            flex: 1, background: 'none', border: 'none', outline: 'none',
                            fontSize: 14, color: 'var(--app-fg)',
                        }}
                    />
                    <kbd style={{
                        fontSize: 10, color: 'var(--app-hint)', padding: '2px 5px',
                        border: '1px solid var(--app-border)', borderRadius: 4,
                        fontFamily: 'inherit',
                    }}>esc</kbd>
                </div>

                {/* Results */}
                <div ref={listRef} style={{ overflowY: 'auto', flex: 1 }}>
                    {query.trim() !== '' && filtered.length === 0 ? (
                        <div style={{ padding: '20px 14px', textAlign: 'center',
                            fontSize: 13, color: 'var(--app-hint)' }}>
                            No sessions match "{query}"
                        </div>
                    ) : filtered.map((s, i) => (
                        <div
                            key={s.id}
                            onClick={() => { onSelect(s); onClose() }}
                            onMouseEnter={() => setActiveIdx(i)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                padding: '7px 14px', cursor: 'pointer',
                                background: i === activeIdx ? 'var(--app-secondary-bg)' : 'transparent',
                            }}
                        >
                            <div style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                                background: s.active ? '#34c759' : 'transparent',
                                border: s.active ? 'none' : '1px solid var(--app-border)',
                            }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13, fontWeight: 500,
                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    color: 'var(--app-fg)' }}>
                                    {getSessionTitle(s)}
                                </div>
                                {getSessionFolder(s) && (
                                    <div style={{ fontSize: 11, color: 'var(--app-hint)',
                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {getSessionFolder(s)}
                                    </div>
                                )}
                            </div>
                            {i === activeIdx && (
                                <span style={{ fontSize: 11, color: 'var(--app-link)', flexShrink: 0 }}>
                                    {actionLabel} ↵
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
