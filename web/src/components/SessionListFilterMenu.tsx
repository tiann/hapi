import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { CheckIcon } from '@/components/icons'
import { FilterIcon, getCenteredFilterMenuLeft, getMachineFilterMenuClampStyle } from '@/components/MachineFilterBar'
import {
    SessionDateFilterMenuRow,
    SessionDateRangePicker
} from '@/components/SessionDateFilter'
import {
    isSessionListFilterSelected,
    SESSION_LIST_FILTER_OPTIONS,
    toggleSessionListFilter,
    type SessionListFilter,
    type SessionListFilterState
} from '@/lib/sessionListFilter'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

export type { SessionListFilter, SessionListFilterState } from '@/lib/sessionListFilter'

export function SessionListFilterMenu(props: {
    value: SessionListFilterState
    onChange: (value: SessionListFilterState) => void
    customStart?: string
    customEnd?: string
    sessionActivityDates?: ReadonlySet<string>
    onDateRangeChange?: (start: string, end: string) => void
    datePickerCenterRef?: RefObject<HTMLElement | null>
    className?: string
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [datePickerOpen, setDatePickerOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const wrapperRef = useRef<HTMLDivElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const dateFilterButtonRef = useRef<HTMLButtonElement>(null)
    const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)
    const [menuLeft, setMenuLeft] = useState<number | null>(null)
    const hasDateFilter = props.customStart !== undefined
        && props.customEnd !== undefined
        && props.sessionActivityDates !== undefined
        && props.onDateRangeChange !== undefined
    const hasDateRange = hasDateFilter && Boolean(props.customStart && props.customEnd)

    const close = useCallback(() => {
        setOpen(false)
        setDatePickerOpen(false)
        triggerRef.current?.focus()
    }, [])

    const closeDatePicker = useCallback(() => {
        setDatePickerOpen(false)
        dateFilterButtonRef.current?.focus()
    }, [])

    const updateMenuPosition = useCallback(() => {
        const wrapper = wrapperRef.current
        const menu = menuRef.current
        if (!wrapper || !menu) return

        const wrapperRect = wrapper.getBoundingClientRect()
        const menuRect = menu.getBoundingClientRect()
        setAnchor({ right: wrapperRect.right, bottom: wrapperRect.bottom })
        setMenuLeft(getCenteredFilterMenuLeft(
            { left: wrapperRect.left, width: wrapperRect.width },
            menuRect.width,
            window.innerWidth
        ))
    }, [])

    useLayoutEffect(() => {
        if (!open) {
            setAnchor(null)
            setMenuLeft(null)
            return
        }

        updateMenuPosition()
        const frame = window.requestAnimationFrame(updateMenuPosition)
        const resizeObserver = typeof ResizeObserver === 'undefined' || !menuRef.current
            ? null
            : new ResizeObserver(updateMenuPosition)
        resizeObserver?.observe(menuRef.current!)
        window.addEventListener('resize', updateMenuPosition)
        window.addEventListener('scroll', updateMenuPosition, true)
        return () => {
            window.cancelAnimationFrame(frame)
            resizeObserver?.disconnect()
            window.removeEventListener('resize', updateMenuPosition)
            window.removeEventListener('scroll', updateMenuPosition, true)
        }
    }, [open, updateMenuPosition])

    const select = (value: Exclude<SessionListFilter, 'all'>) => {
        setDatePickerOpen(false)
        props.onChange(toggleSessionListFilter(props.value, value))
    }

    useEffect(() => {
        if (!open) return

        const frame = window.requestAnimationFrame(() => {
            const selected = menuRef.current?.querySelector<HTMLElement>(
                '[role="menuitemradio"][aria-checked="true"], [role="menuitemcheckbox"][aria-checked="true"], [role="menuitem"][aria-expanded="true"]'
            )
            const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]')
            ;(selected ?? first)?.focus()
        })

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                close()
                return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            const items = Array.from(
                menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]') ?? []
            )
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
    }, [close, open])

    return (
        <div ref={wrapperRef} className={cn('relative shrink-0', props.className)}>
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen(value => !value)}
                aria-label={t('sessions.filter.label')}
                title={t('sessions.filter.label')}
                aria-haspopup="menu"
                aria-expanded={open}
                className={cn(
                    'relative flex h-9 w-9 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]',
                    (props.value.unread || props.value.scratchlist || hasDateRange)
                        && 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                )}
            >
                <FilterIcon className="h-5 w-5" />
                {props.value.unread || props.value.scratchlist || hasDateRange ? (
                    <span
                        aria-hidden="true"
                        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--app-link)]"
                    />
                ) : null}
            </button>
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
                        aria-label={t('sessions.filter.label')}
                        style={{
                            ...(anchor
                                ? getMachineFilterMenuClampStyle(anchor, { widthCap: null, horizontal: 'center' })
                                : {}),
                            left: menuLeft === null ? '50%' : menuLeft,
                            transform: menuLeft === null ? 'translateX(-50%)' : 'none'
                        }}
                        className="absolute top-full z-30 mt-1 w-max max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-xl"
                    >
                        {SESSION_LIST_FILTER_OPTIONS.map((option) => {
                            const selected = isSessionListFilterSelected(props.value, option.value)
                            return (
                                <Fragment key={option.value}>
                                    <button
                                        type="button"
                                        role="menuitemcheckbox"
                                        aria-checked={selected}
                                        onClick={() => select(option.value)}
                                        className={cn(
                                            'flex w-full items-center gap-2 rounded-lg py-2 pl-2.5 pr-2 text-left text-sm transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                                            selected && 'text-[var(--app-link)]'
                                        )}
                                    >
                                        <span className="flex h-5 w-4 shrink-0 items-center justify-center text-[var(--app-link)]">
                                            {selected ? <CheckIcon className="h-4 w-4" /> : null}
                                        </span>
                                        <span className="min-w-0 flex-auto truncate whitespace-nowrap">{t(option.labelKey)}</span>
                                    </button>
                                    {hasDateFilter && option.value === 'unread' ? (
                                        <SessionDateFilterMenuRow
                                            start={props.customStart!}
                                            end={props.customEnd!}
                                            expanded={datePickerOpen}
                                            buttonRef={dateFilterButtonRef}
                                            onSelect={() => setDatePickerOpen(value => !value)}
                                        />
                                    ) : null}
                                </Fragment>
                            )
                        })}
                    </div>
                </>
            ) : null}
            {open && datePickerOpen && hasDateFilter ? (
                <SessionDateRangePicker
                    start={props.customStart!}
                    end={props.customEnd!}
                    sessionActivityDates={props.sessionActivityDates!}
                    onChange={props.onDateRangeChange!}
                    onClear={() => {
                        props.onDateRangeChange!('', '')
                        dateFilterButtonRef.current?.focus()
                    }}
                    onClose={closeDatePicker}
                    align="right"
                    anchorRef={dateFilterButtonRef}
                    horizontalCenterRef={props.datePickerCenterRef}
                />
            ) : null}
        </div>
    )
}
