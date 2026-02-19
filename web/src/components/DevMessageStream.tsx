import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DecryptedMessage } from '@/types/api'

type FilterState = {
    roles: Set<string>
    types: Set<string>
}

function extractMessageInfo(content: unknown): { role: string; type: string } {
    if (!content || typeof content !== 'object') {
        return { role: 'unknown', type: 'unknown' }
    }

    const record = content as Record<string, unknown>
    const role = typeof record.role === 'string' ? record.role : 'unknown'

    // Check inner content for type
    const inner = record.content
    if (Array.isArray(inner) && inner.length > 0) {
        const first = inner[0]
        if (first && typeof first === 'object' && 'type' in first) {
            return { role, type: String((first as Record<string, unknown>).type) }
        }
    }
    if (inner && typeof inner === 'object' && 'type' in inner) {
        return { role, type: String((inner as Record<string, unknown>).type) }
    }
    if (typeof record.type === 'string') {
        return { role, type: record.type }
    }

    return { role, type: 'message' }
}

function formatTimestamp(ts: number): string {
    const d = new Date(ts)
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
}

const ROLE_BG: Record<string, string> = {
    user: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    agent: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    system: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    unknown: 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] border-[var(--app-border)]',
}

const KNOWN_ROLES = ['user', 'agent', 'system']
const ALL_TYPES = ['text', 'tool_use', 'tool_result', 'message', 'other']

function FilterToggle(props: {
    label: string
    active: boolean
    onClick: () => void
    colorClass?: string
}) {
    return (
        <button
            type="button"
            onClick={props.onClick}
            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-all ${
                props.active
                    ? props.colorClass ?? 'bg-[var(--app-link)]/15 text-[var(--app-link)] border-[var(--app-link)]/30'
                    : 'bg-transparent text-[var(--app-hint)] border-[var(--app-border)] opacity-50'
            }`}
        >
            {props.label}
        </button>
    )
}

function MessageEntry(props: {
    message: DecryptedMessage
    info: { role: string; type: string }
    expanded: boolean
    onToggle: () => void
}) {
    const { message, info, expanded, onToggle } = props
    const roleBg = ROLE_BG[info.role] ?? ROLE_BG.unknown

    return (
        <div
            className="border-b border-[var(--app-border)]/50 hover:bg-[var(--app-subtle-bg)]/50 transition-colors cursor-pointer"
            onClick={onToggle}
        >
            <div className="flex items-center gap-2 px-3 py-1.5">
                <span className="text-[11px] text-[var(--app-hint)] font-mono tabular-nums w-[72px] shrink-0">
                    {formatTimestamp(message.createdAt)}
                </span>
                <span className="text-[11px] text-[var(--app-hint)] font-mono tabular-nums w-[36px] shrink-0 text-right">
                    #{message.seq ?? '—'}
                </span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${roleBg}`}>
                    {info.role}
                </span>
                <span className="text-[11px] text-[var(--app-hint)] font-mono">
                    {info.type}
                </span>
                <span className="ml-auto text-[10px] text-[var(--app-hint)]">
                    {expanded ? '▼' : '▶'}
                </span>
            </div>
            {expanded ? (
                <div className="px-3 pb-2">
                    <pre className="text-[11px] font-mono leading-relaxed text-[var(--app-fg)] whitespace-pre-wrap break-all overflow-x-auto bg-[var(--app-secondary-bg)] rounded-md p-2 border border-[var(--app-border)]">
                        {JSON.stringify(message.content, null, 2)}
                    </pre>
                </div>
            ) : null}
        </div>
    )
}

export function DevMessageStream(props: {
    messages: DecryptedMessage[]
}) {
    const { messages } = props
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const [autoScroll, setAutoScroll] = useState(true)
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
    const [filters, setFilters] = useState<FilterState>({
        roles: new Set(KNOWN_ROLES),
        types: new Set(ALL_TYPES),
    })

    const toggleRole = useCallback((role: string) => {
        setFilters(prev => {
            const next = new Set(prev.roles)
            if (next.has(role)) {
                next.delete(role)
            } else {
                next.add(role)
            }
            return { ...prev, roles: next }
        })
    }, [])

    const toggleType = useCallback((type: string) => {
        setFilters(prev => {
            const next = new Set(prev.types)
            if (next.has(type)) {
                next.delete(type)
            } else {
                next.add(type)
            }
            return { ...prev, types: next }
        })
    }, [])

    const toggleExpanded = useCallback((id: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) {
                next.delete(id)
            } else {
                next.add(id)
            }
            return next
        })
    }, [])

    const expandAll = useCallback(() => {
        setExpandedIds(new Set(messages.map(m => m.id)))
    }, [messages])

    const collapseAll = useCallback(() => {
        setExpandedIds(new Set())
    }, [])

    // Pre-compute message info to avoid recalculating during filter + render
    const messagesWithInfo = useMemo(
        () => messages.map(msg => ({ msg, info: extractMessageInfo(msg.content) })),
        [messages]
    )

    // Filter messages — unknown roles always pass (they're rare edge cases)
    const filteredMessages = useMemo(() => messagesWithInfo.filter(({ info }) => {
        const isKnownRole = KNOWN_ROLES.includes(info.role)
        const roleMatch = !isKnownRole || filters.roles.has(info.role)
        const typeMatch = filters.types.has(info.type) || (!ALL_TYPES.includes(info.type) && filters.types.has('other'))
        return roleMatch && typeMatch
    }), [messagesWithInfo, filters])

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        if (autoScroll && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
    }, [filteredMessages.length, autoScroll])

    // Detect manual scroll to disable auto-scroll
    const handleScroll = useCallback(() => {
        if (!scrollRef.current) return
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
        const atBottom = scrollHeight - scrollTop - clientHeight < 40
        setAutoScroll(atBottom)
    }, [])

    return (
        <div className="flex h-full flex-col bg-[var(--app-bg)]">
            {/* Filter bar */}
            <div className="sticky top-0 z-10 border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2">
                <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">Role</span>
                    <div className="flex items-center gap-1">
                        {KNOWN_ROLES.map(role => (
                            <FilterToggle
                                key={role}
                                label={role}
                                active={filters.roles.has(role)}
                                onClick={() => toggleRole(role)}
                                colorClass={filters.roles.has(role)
                                    ? `${ROLE_BG[role] ?? ROLE_BG.unknown}`
                                    : undefined
                                }
                            />
                        ))}
                    </div>

                    <span className="text-[var(--app-border)]">|</span>

                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">Type</span>
                    <div className="flex items-center gap-1">
                        {ALL_TYPES.map(type => (
                            <FilterToggle
                                key={type}
                                label={type}
                                active={filters.types.has(type)}
                                onClick={() => toggleType(type)}
                            />
                        ))}
                    </div>

                    <span className="text-[var(--app-border)]">|</span>

                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={expandAll}
                            className="px-2 py-0.5 rounded text-[11px] text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                        >
                            Expand all
                        </button>
                        <button
                            type="button"
                            onClick={collapseAll}
                            className="px-2 py-0.5 rounded text-[11px] text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                        >
                            Collapse all
                        </button>
                    </div>

                    <div className="ml-auto flex items-center gap-2">
                        <span className="text-[11px] text-[var(--app-hint)] font-mono tabular-nums">
                            {filteredMessages.length}/{messages.length}
                        </span>
                        <button
                            type="button"
                            onClick={() => setAutoScroll(v => !v)}
                            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-all ${
                                autoScroll
                                    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                    : 'bg-transparent text-[var(--app-hint)] border-[var(--app-border)] opacity-50'
                            }`}
                            title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll disabled'}
                        >
                            {autoScroll ? '⬇ Follow' : '⬇ Paused'}
                        </button>
                    </div>
                </div>
            </div>

            {/* Message stream */}
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="flex-1 min-h-0 overflow-y-auto"
            >
                {filteredMessages.length === 0 ? (
                    <div className="flex items-center justify-center h-32 text-sm text-[var(--app-hint)]">
                        {messages.length === 0
                            ? 'No messages yet'
                            : 'No messages match current filters'
                        }
                    </div>
                ) : (
                    filteredMessages.map(({ msg, info }) => (
                        <MessageEntry
                            key={msg.id}
                            message={msg}
                            info={info}
                            expanded={expandedIds.has(msg.id)}
                            onToggle={() => toggleExpanded(msg.id)}
                        />
                    ))
                )}
            </div>
        </div>
    )
}
