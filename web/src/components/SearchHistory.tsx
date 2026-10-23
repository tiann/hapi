import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from 'react'
import { useSearchHistory, type SearchHistoryType } from '@/lib/search-history'
import { useTranslation } from '@/lib/use-translation'
import { CloseIcon } from '@/components/icons'

export function useSearchHistoryField(type: SearchHistoryType, query: string, onChange: (query: string) => void, inputRef: RefObject<HTMLInputElement | null>) {
    const history = useSearchHistory()
    const [open, setOpen] = useState(false)
    const [composing, setComposing] = useState(false)
    const composingRef = useRef(false)
    const dirty = useRef(false)
    const pendingQuery = useRef('')
    const panelId = useId()
    const panelRef = useRef<HTMLDivElement>(null)
    const record = useRef(history.record)
    record.current = history.record

    const commit = () => {
        if (!dirty.current || composingRef.current) return
        dirty.current = false
        record.current(type, pendingQuery.current)
    }
    const commitRef = useRef(commit)
    commitRef.current = commit
    useEffect(() => {
        // Closing a panel or navigating away also completes a search on touch devices.
        const onPageHide = () => commitRef.current()
        window.addEventListener('pagehide', onPageHide)
        return () => {
            window.removeEventListener('pagehide', onPageHide)
            commitRef.current()
        }
    }, [type])
    useEffect(() => {
        if (!history.state.enabled) dirty.current = false
    }, [history.state.enabled])

    const visible = open && !composing && history.state.enabled && query.length === 0 && history.state[type].length > 0
    const focusEntry = (last = false) => {
        const entries = panelRef.current?.querySelectorAll<HTMLButtonElement>('[data-history-query]')
        entries?.[last ? entries.length - 1 : 0]?.focus()
    }
    const blur = (event: FocusEvent<HTMLElement>) => {
        commit()
        if (event.relatedTarget === inputRef.current || panelRef.current?.contains(event.relatedTarget as Node | null)) return
        setOpen(false)
    }
    return {
        inputProps: {
            autoComplete: 'off',
            'aria-controls': visible ? panelId : undefined,
            onFocus: () => setOpen(true),
            onBlur: blur,
            onChange: (event: { target: { value: string } }) => {
                dirty.current = history.state.enabled
                // Keep unmount/pagehide recording in sync even before React commits a render.
                pendingQuery.current = event.target.value
                onChange(event.target.value)
                setOpen(true)
            },
            onCompositionStart: () => { composingRef.current = true; setComposing(true) },
            onCompositionEnd: () => { composingRef.current = false; setComposing(false) },
            onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
                if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return
                if (event.key === 'Enter') { commit(); setOpen(false) }
                if (event.key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); setOpen(false) }
                if (visible && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                    event.preventDefault()
                    focusEntry(event.key === 'ArrowUp')
                }
            },
        },
        suggestions: visible ? <SearchHistorySuggestions
            id={panelId} panelRef={panelRef} entries={history.state[type]}
            onBlur={blur}
            onSelect={entry => {
                dirty.current = false
                history.record(type, entry)
                onChange(entry)
                inputRef.current?.focus()
                setOpen(false)
            }}
            onRemove={entry => { history.remove(type, entry); inputRef.current?.focus() }}
            onClear={() => { history.clear(type); inputRef.current?.focus() }}
            onClose={() => { inputRef.current?.focus(); setOpen(false) }}
        /> : null,
    }
}

function SearchHistorySuggestions(props: {
    id: string
    panelRef: RefObject<HTMLDivElement | null>
    entries: string[]
    onSelect: (query: string) => void
    onRemove: (query: string) => void
    onClear: () => void
    onClose: () => void
    onBlur: (event: FocusEvent<HTMLElement>) => void
}) {
    const { t } = useTranslation()
    return <div
        id={props.id} ref={props.panelRef} role="region" aria-label={t('searchHistory.recent')}
        className="absolute inset-x-0 top-full z-40 mt-1 max-h-[min(20rem,45dvh)] overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] shadow-lg"
        onBlur={props.onBlur}
        onMouseDown={event => {
            // WebKit does not focus buttons on pointer activation. Keep the field
            // focused until click runs so blur cannot remove a touch/click target.
            if (event.button === 0 && (event.target as HTMLElement).closest('button')) event.preventDefault()
        }}
        onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose() }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-history-query]')]
                const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
                const next = current + (event.key === 'ArrowDown' ? 1 : -1)
                event.preventDefault()
                buttons[(next + buttons.length) % buttons.length]?.focus()
            }
        }}
    >
        <div className="flex items-center justify-between gap-2 border-b border-[var(--app-border)] px-3 text-xs text-[var(--app-hint)]">
            <span>{t('searchHistory.recent')}</span>
            <button type="button" onClick={props.onClear} className="min-h-10 px-2 text-[var(--app-link)] hover:underline">{t('searchHistory.clear')}</button>
        </div>
        <ul>
            {props.entries.map(entry => <li key={entry} className="flex min-w-0 items-stretch">
                <button type="button" data-history-query="" onClick={() => props.onSelect(entry)} title={entry}
                    className="min-h-11 min-w-0 flex-1 truncate px-3 text-left text-sm hover:bg-[var(--app-subtle-bg)] focus-visible:outline focus-visible:outline-[var(--app-link)]">{entry}</button>
                <button type="button" onClick={() => props.onRemove(entry)} aria-label={t('searchHistory.remove', { query: entry })}
                    className="flex min-h-11 w-11 shrink-0 items-center justify-center text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] focus-visible:outline focus-visible:outline-[var(--app-link)]"><CloseIcon className="h-4 w-4" /></button>
            </li>)}
        </ul>
    </div>
}
