import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'
import { CheckIcon } from '@/components/icons'
import { useFue } from '@/lib/use-fue'
import { FueCallout, FueDot } from '@/components/Fue'
import {
    getMachineFilterMenuClampStyle,
    machineFilterMenuAlignsStart,
    type MachineFilterMenuAnchor
} from '@/components/MachineFilterBar'
import {
    isDefaultSessionListView,
    type SessionListSort,
    type SessionListStatus,
    type SessionListView
} from '@/hooks/useSessionListView'

function SortFilterIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 6h13" />
            <path d="M3 12h9" />
            <path d="M3 18h5" />
            <path d="m17 15 3 3 3-3" />
            <path d="M20 18V6" />
        </svg>
    )
}

const SORT_OPTIONS: Array<{ value: SessionListSort; labelKey: string }> = [
    { value: 'last-message', labelKey: 'sessions.view.sort.lastMessage' },
    { value: 'created', labelKey: 'sessions.view.sort.created' }
]

const STATUS_OPTIONS: Array<{ value: SessionListStatus; labelKey: string }> = [
    { value: 'all', labelKey: 'sessions.view.status.all' },
    { value: 'active', labelKey: 'sessions.view.status.active' },
    { value: 'archived', labelKey: 'sessions.view.status.archived' }
]

const ITEM_SELECTOR = '[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]'

function MenuRow(props: {
    role: 'menuitemradio' | 'menuitemcheckbox' | 'menuitem'
    label: string
    checked?: boolean
    onSelect: () => void
}) {
    return (
        <button
            type="button"
            role={props.role}
            aria-checked={props.role === 'menuitem' ? undefined : Boolean(props.checked)}
            onClick={props.onSelect}
            className={cn(
                'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                'hover:bg-[var(--app-subtle-bg)] focus-visible:bg-[var(--app-subtle-bg)] focus-visible:outline-none',
                props.checked ? 'text-[var(--app-link)]' : 'text-[var(--app-fg)]'
            )}
        >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {props.checked ? <CheckIcon className="h-4 w-4" /> : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{props.label}</span>
        </button>
    )
}

function SectionLabel(props: { children: string }) {
    return (
        <div className="px-3 pb-1 pt-2 text-xs font-semibold text-[var(--app-hint)]">
            {props.children}
        </div>
    )
}

/**
 * Session list sort + filter menu: sort key, status filter and active-first
 * ordering. Choices apply immediately and the menu stays open so several can
 * be combined; a dot on the trigger marks a non-default view.
 */
export function SessionListViewMenu(props: {
    view: SessionListView
    onChange: (patch: Partial<SessionListView>) => void
    onReset: () => void
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const wrapperRef = useRef<HTMLDivElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const [anchor, setAnchor] = useState<MachineFilterMenuAnchor | null>(null)
    const customized = !isDefaultSessionListView(props.view)
    const fue = useFue('session-list-view-menu')

    const close = useCallback(() => {
        setOpen(false)
        triggerRef.current?.focus()
    }, [])

    useLayoutEffect(() => {
        if (!open) {
            setAnchor(null)
            return
        }
        const updateAnchor = () => {
            const rect = wrapperRef.current?.getBoundingClientRect()
            if (!rect) return
            setAnchor({ left: rect.left, right: rect.right, bottom: rect.bottom })
        }
        updateAnchor()
        window.addEventListener('resize', updateAnchor)
        return () => window.removeEventListener('resize', updateAnchor)
    }, [open])

    useEffect(() => {
        if (!open) return
        const frame = window.requestAnimationFrame(() => {
            menuRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus()
        })
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                close()
                return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])
            if (items.length === 0) return
            event.preventDefault()
            const delta = event.key === 'ArrowDown' ? 1 : -1
            const currentIndex = items.indexOf(document.activeElement as HTMLElement)
            const nextIndex = currentIndex === -1
                ? (delta === 1 ? 0 : items.length - 1)
                : (currentIndex + delta + items.length) % items.length
            items[nextIndex]?.focus()
        }
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            window.cancelAnimationFrame(frame)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [open, close])

    const alignStart = anchor ? machineFilterMenuAlignsStart(anchor, window.innerWidth) : false
    const label = t('sessions.view.label')

    return (
        <div ref={wrapperRef} className="relative shrink-0">
            <button
                ref={triggerRef}
                type="button"
                data-testid="session-list-view-button"
                onClick={() => {
                    fue.engage()
                    setOpen(value => !value)
                }}
                aria-label={label}
                title={label}
                aria-haspopup="menu"
                aria-expanded={open}
                className={cn(
                    'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors',
                    'hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                    customized ? 'text-[var(--app-link)]' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                )}
            >
                <SortFilterIcon className="h-5 w-5" />
                {customized ? (
                    <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--app-link)]" aria-hidden="true" />
                ) : null}
                {!customized && fue.status !== 'acknowledged' ? (
                    <FueDot
                        pulsing={fue.status === 'unseen'}
                        ariaLabel={t('fue.newFeatureDot')}
                    />
                ) : null}
            </button>
            {fue.status === 'engaging' ? (
                <FueCallout
                    title={t('sessions.view.fueTitle')}
                    body={t('sessions.view.fueBody')}
                    onDismiss={fue.dismiss}
                    dismissLabel={t('fue.gotIt')}
                    closeAriaLabel={t('fue.closeAriaLabel')}
                    anchorRef={triggerRef}
                />
            ) : null}
            {open ? (
                <>
                    <button
                        type="button"
                        aria-label={t('button.close')}
                        tabIndex={-1}
                        className="fixed inset-0 z-20 cursor-default"
                        onClick={close}
                    />
                    <div
                        ref={menuRef}
                        role="menu"
                        aria-label={label}
                        style={anchor ? getMachineFilterMenuClampStyle(anchor) : undefined}
                        className={cn(
                            'absolute top-full z-30 mt-1 w-64 overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-xl',
                            alignStart ? 'left-0' : 'right-0'
                        )}
                    >
                        <div role="group" aria-label={t('sessions.view.sort')}>
                            <SectionLabel>{t('sessions.view.sort')}</SectionLabel>
                            {SORT_OPTIONS.map((option) => (
                                <MenuRow
                                    key={option.value}
                                    role="menuitemradio"
                                    label={t(option.labelKey)}
                                    checked={props.view.sort === option.value}
                                    onSelect={() => props.onChange({ sort: option.value })}
                                />
                            ))}
                            <MenuRow
                                role="menuitemcheckbox"
                                label={t('sessions.view.activeFirst')}
                                checked={props.view.activeFirst}
                                onSelect={() => props.onChange({ activeFirst: !props.view.activeFirst })}
                            />
                        </div>
                        <div className="mx-3 my-1 h-px bg-[var(--app-divider)]" />
                        <div role="group" aria-label={t('sessions.view.status')}>
                            <SectionLabel>{t('sessions.view.status')}</SectionLabel>
                            {STATUS_OPTIONS.map((option) => (
                                <MenuRow
                                    key={option.value}
                                    role="menuitemradio"
                                    label={t(option.labelKey)}
                                    checked={props.view.status === option.value}
                                    onSelect={() => props.onChange({ status: option.value })}
                                />
                            ))}
                            <MenuRow
                                role="menuitemcheckbox"
                                label={t('sessions.view.unreadOnly')}
                                checked={props.view.unreadOnly}
                                onSelect={() => props.onChange({ unreadOnly: !props.view.unreadOnly })}
                            />
                        </div>
                        {customized ? (
                            <>
                                <div className="mx-3 my-1 h-px bg-[var(--app-divider)]" />
                                <MenuRow role="menuitem" label={t('sessions.view.reset')} onSelect={props.onReset} />
                            </>
                        ) : null}
                    </div>
                </>
            ) : null}
        </div>
    )
}
