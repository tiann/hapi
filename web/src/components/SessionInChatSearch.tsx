import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionContentMatch } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { useFue } from '@/lib/use-fue'
import { FueCallout, FueDot } from '@/components/Fue'
import { formatAbsoluteDateTime, formatRelativeTime } from '@/lib/relativeTime'
import { useMinuteTick } from '@/hooks/useMinuteTick'
import { highlightSearchSnippet } from '@/components/highlightSearchSnippet'

const DEBOUNCE_MS = 180
const MIN_QUERY_LENGTH = 2
const RESULT_LIMIT = 50

function SearchIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
        </svg>
    )
}

function roleLabel(
    role: SessionContentMatch['role'],
    t: (key: string) => string
): string {
    return role === 'user' ? t('session.outline.kind.user') : t('session.inChatSearch.roleAssistant')
}

function renderHighlightedSnippet(snippet: string, query: string): ReactNode {
    return highlightSearchSnippet(snippet, query).map((part, index) => {
        if (part.type === 'mark') {
            return (
                <mark
                    key={`m-${index}`}
                    className="hapi-message-search-target px-0.5"
                >
                    {part.value}
                </mark>
            )
        }
        return <span key={`t-${index}`}>{part.value}</span>
    })
}

export function SessionInChatSearch(props: {
    api: ApiClient
    sessionId: string
    onSelectMatch: (messageId: string, query: string) => void
}) {
    const { t } = useTranslation()
    const fue = useFue('session-in-chat-search')
    const toggleRef = useRef<HTMLButtonElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const panelId = useId()
    const listboxId = useId()

    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [matches, setMatches] = useState<SessionContentMatch[]>([])
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(false)
    const [activeIndex, setActiveIndex] = useState(0)
    // Relative ages on hit cards should advance while the panel stays open.
    const relativeTimeTick = useMinuteTick(open)

    const normalizedQuery = query.trim()
    const queryReady = normalizedQuery.length >= MIN_QUERY_LENGTH

    useEffect(() => {
        if (!open) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                setOpen(false)
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [open])

    // HAPI-owned shortcut: Ctrl/Cmd+Shift+F. Do not steal browser Ctrl/Cmd+F.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const isModifier = event.metaKey || event.ctrlKey
            if (!isModifier || !event.shiftKey) return
            if (event.key.toLowerCase() !== 'f') return
            const target = event.target
            if (target instanceof HTMLElement) {
                const tag = target.tagName
                if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) {
                    if (target !== inputRef.current) return
                }
            }
            event.preventDefault()
            fue.engage()
            setOpen(true)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [fue])

    useEffect(() => {
        if (!open) return
        const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
        return () => window.clearTimeout(timer)
    }, [open])

    useEffect(() => {
        if (!open || !queryReady) {
            setMatches([])
            setTotal(0)
            setLoading(false)
            setError(false)
            return
        }

        const controller = new AbortController()
        setMatches([])
        setError(false)
        const timer = window.setTimeout(() => {
            setLoading(true)
            void props.api.searchSessionContentMatches(
                props.sessionId,
                normalizedQuery,
                RESULT_LIMIT,
                controller.signal
            )
                .then((response) => {
                    if (controller.signal.aborted) return
                    setMatches(response.matches)
                    setTotal(response.total)
                    setActiveIndex(0)
                })
                .catch(() => {
                    if (controller.signal.aborted) return
                    setMatches([])
                    setTotal(0)
                    setError(true)
                })
                .finally(() => {
                    if (!controller.signal.aborted) setLoading(false)
                })
        }, DEBOUNCE_MS)

        return () => {
            window.clearTimeout(timer)
            controller.abort()
        }
    }, [normalizedQuery, open, props.api, props.sessionId, queryReady])

    const selectMatch = (match: SessionContentMatch) => {
        props.onSelectMatch(match.messageId, normalizedQuery)
        setOpen(false)
    }

    const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (matches.length === 0) return
            setActiveIndex((index) => (index + 1) % matches.length)
            return
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault()
            if (matches.length === 0) return
            setActiveIndex((index) => (index - 1 + matches.length) % matches.length)
            return
        }
        if (event.key === 'Enter') {
            event.preventDefault()
            const match = matches[activeIndex]
            if (match) selectMatch(match)
            return
        }
        if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
        }
    }

    return (
        <div className="relative flex items-center">
            <button
                ref={toggleRef}
                type="button"
                data-testid="session-in-chat-search-toggle"
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                title={t('session.inChatSearch.openTitle')}
                aria-label={t('session.inChatSearch.open')}
                onClick={() => {
                    fue.engage()
                    setOpen((value) => !value)
                }}
                className={`relative flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                    open
                        ? 'bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90'
                        : 'text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]'
                }`}
            >
                <SearchIcon />
                {fue.status !== 'acknowledged' ? (
                    <FueDot
                        pulsing={fue.status === 'unseen'}
                        ariaLabel={t('fue.newFeatureDot')}
                    />
                ) : null}
            </button>
            {fue.status === 'engaging' ? (
                <FueCallout
                    title={t('session.inChatSearch.fueTitle')}
                    body={t('session.inChatSearch.fueBody')}
                    onDismiss={fue.dismiss}
                    dismissLabel={t('fue.gotIt')}
                    closeAriaLabel={t('fue.closeAriaLabel')}
                    anchorRef={toggleRef}
                />
            ) : null}

            {open ? (
                <div
                    id={panelId}
                    data-testid="session-in-chat-search-panel"
                    className="absolute right-0 top-full z-30 mt-1 w-[min(30rem,calc(100vw-2rem))] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-2 shadow-lg"
                >
                    <label className="sr-only" htmlFor={`${panelId}-input`}>
                        {t('session.inChatSearch.inputLabel')}
                    </label>
                    <input
                        ref={inputRef}
                        id={`${panelId}-input`}
                        data-testid="session-in-chat-search-input"
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={handleInputKeyDown}
                        placeholder={t('session.inChatSearch.placeholder')}
                        autoComplete="off"
                        role="combobox"
                        aria-expanded={queryReady}
                        aria-controls={listboxId}
                        aria-autocomplete="list"
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:border-[var(--app-button)]"
                    />

                    <div className="mt-2 max-h-[28rem] overflow-y-auto" role="listbox" id={listboxId}>
                        {!queryReady ? (
                            <div className="px-2 py-2 text-xs text-[var(--app-hint)]">
                                {t('session.inChatSearch.minQuery')}
                            </div>
                        ) : loading ? (
                            <div className="px-2 py-2 text-xs text-[var(--app-hint)]">
                                {t('session.inChatSearch.loading')}
                            </div>
                        ) : error ? (
                            <div className="px-2 py-2 text-xs text-red-600">
                                {t('session.inChatSearch.error')}
                            </div>
                        ) : matches.length === 0 ? (
                            <div className="px-2 py-2 text-xs text-[var(--app-hint)]">
                                {t('session.inChatSearch.noResults')}
                            </div>
                        ) : (
                            <>
                                <div className="px-2 pb-1.5 text-[10px] uppercase tracking-wide text-[var(--app-hint)]">
                                    {t('session.inChatSearch.results', {
                                        shown: String(matches.length),
                                        total: total > matches.length
                                            ? `${matches.length}+`
                                            : String(total),
                                    })}
                                </div>
                                <div className="divide-y divide-[var(--app-divider)] rounded-md border border-[var(--app-border)]/60">
                                    {matches.map((match, index) => {
                                        const selected = index === activeIndex
                                        const ageLabel = match.createdAt > 0
                                            ? formatRelativeTime(match.createdAt, t)
                                            : null
                                        // relativeTimeTick keeps labels fresh while open
                                        void relativeTimeTick
                                        const absolute = match.createdAt > 0
                                            ? formatAbsoluteDateTime(match.createdAt)
                                            : null
                                        return (
                                            <button
                                                key={match.messageId}
                                                type="button"
                                                role="option"
                                                aria-selected={selected}
                                                data-testid={`session-in-chat-search-hit-${match.messageId}`}
                                                onMouseEnter={() => setActiveIndex(index)}
                                                onClick={() => selectMatch(match)}
                                                className={`flex w-full flex-col gap-1 px-2.5 py-2.5 text-left transition-colors first:rounded-t-[5px] last:rounded-b-[5px] ${
                                                    selected
                                                        ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)]'
                                                        : 'bg-transparent text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                                }`}
                                            >
                                                <span className="flex min-w-0 items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                                                    <span className="truncate">{roleLabel(match.role, t)}</span>
                                                    {ageLabel ? (
                                                        <span
                                                            data-testid={`session-in-chat-search-hit-age-${match.messageId}`}
                                                            className="shrink-0 normal-case tracking-normal tabular-nums"
                                                            title={absolute ?? undefined}
                                                        >
                                                            {ageLabel}
                                                        </span>
                                                    ) : null}
                                                </span>
                                                <span className="line-clamp-2 min-h-[2.7em] break-words text-[13px] leading-[1.35] text-[var(--app-fg)]">
                                                    {renderHighlightedSnippet(match.snippet, normalizedQuery)}
                                                </span>
                                            </button>
                                        )
                                    })}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            ) : null}
        </div>
    )
}
