import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { CSSProperties } from 'react'
import type { MachineHealthPresentation } from '@/lib/machineHealth'
import { MachineHealthTooltipBody } from '@/components/MachineHealthIndicator'
import { HoverTooltip } from '@/components/HoverTooltip'
import { CheckIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import {
    isSessionListFilterSelected,
    SESSION_LIST_FILTER_OPTIONS,
    toggleSessionListFilter,
    type SessionListFilter,
    type SessionListFilterState
} from '@/lib/sessionListFilter'
import {
    SessionDateFilterMenuRow,
    SessionDateRangePicker
} from '@/components/SessionDateFilter'
import { useTranslation } from '@/lib/use-translation'

export type MachineFilterItem = {
    id: string
    label: string
    sessionCount: number
    healthPresentation: MachineHealthPresentation | null
}

const chipBaseClass = 'flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors'
const chipSelectedClass = 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)] font-medium'
const chipIdleClass = 'border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'

export function FilterIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={props.className}
        >
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
    )
}

function MachineFilterChip(props: {
    machine: MachineFilterItem
    selected: boolean
    onSelect: (id: string) => void
}) {
    const { machine, selected, onSelect } = props
    const tooltipId = useId()
    const hasHealth = machine.healthPresentation && machine.healthPresentation.metrics.length > 0

    // The button carries the pill's padding so the entire visible chip is
    // clickable; when a health popup wraps it, the wrapper only draws the border.
    const button = (
        <button
            type="button"
            onClick={() => onSelect(machine.id)}
            aria-pressed={selected}
            aria-describedby={hasHealth ? tooltipId : undefined}
            title={machine.label}
            className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
        >
            <span className="max-w-32 truncate">{machine.label}</span>
            <span className="tabular-nums opacity-70">({machine.sessionCount})</span>
        </button>
    )

    if (!hasHealth) {
        return (
            <button
                type="button"
                onClick={() => onSelect(machine.id)}
                aria-pressed={selected}
                title={machine.label}
                className={cn(chipBaseClass, selected ? chipSelectedClass : chipIdleClass)}
            >
                <span className="max-w-32 truncate">{machine.label}</span>
                <span className="tabular-nums opacity-70">({machine.sessionCount})</span>
            </button>
        )
    }

    return (
        // CPU/RAM details live in a hover popup so the chip stays compact;
        // hidden below the md breakpoint (touch devices). The `before:` bridge
        // spans the mt-1 gap so the popup stays open while the pointer enters it.
        <HoverTooltip
            id={tooltipId}
            target={button}
            side="bottom"
            align="start"
            className={cn('shrink-0 rounded-full border transition-colors', selected ? chipSelectedClass : chipIdleClass)}
            tooltipClassName="pointer-events-auto before:absolute before:inset-x-0 before:-top-1 before:h-1 before:content-[''] px-3 py-2 min-w-[16rem] max-md:hidden"
        >
            <MachineHealthTooltipBody presentation={machine.healthPresentation!} />
        </HoverTooltip>
    )
}

export function MachineFilterBar(props: {
    machines: MachineFilterItem[]
    totalCount: number
    value: string | null
    onChange: (id: string | null) => void
}) {
    const { t } = useTranslation()
    return (
        <div
            role="group"
            aria-label={t('sessions.machineFilter.label')}
            className="flex flex-wrap items-center gap-1.5 px-2 pb-2 max-md:hidden"
        >
            <button
                type="button"
                onClick={() => props.onChange(null)}
                aria-pressed={props.value === null}
                className={cn(chipBaseClass, props.value === null ? chipSelectedClass : chipIdleClass)}
            >
                <span className="truncate">{t('sessions.machineFilter.all')}</span>
                <span className="tabular-nums opacity-70">({props.totalCount})</span>
            </button>
            {props.machines.map((machine) => (
                <MachineFilterChip
                    key={machine.id}
                    machine={machine}
                    selected={props.value === machine.id}
                    onSelect={props.onChange}
                />
            ))}
        </div>
    )
}

function MachineFilterMenuRow(props: {
    label: string
    count: number
    selected: boolean
    healthPresentation: MachineHealthPresentation | null
    onSelect: () => void
}) {
    const hasHealth = props.healthPresentation && props.healthPresentation.metrics.length > 0
    return (
        <button
            type="button"
            role="menuitemradio"
            aria-checked={props.selected}
            onClick={props.onSelect}
            className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
        >
            <span className="flex h-5 w-4 shrink-0 items-center justify-center text-[var(--app-link)]">
                {props.selected ? <CheckIcon className="h-4 w-4" /> : null}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-[var(--app-fg)]">{props.label}</span>
                    <span className="shrink-0 tabular-nums text-xs text-[var(--app-hint)]">({props.count})</span>
                </span>
                {hasHealth ? (
                    <span className="mt-0.5 block truncate text-xs tabular-nums text-[var(--app-hint)]">
                        {props.healthPresentation!.metrics.map((metric) => `${metric.shortLabel} ${metric.percent}%`).join(' · ')}
                    </span>
                ) : null}
            </span>
        </button>
    )
}

function SessionFilterMenuRow(props: {
    label: string
    selected: boolean
    onSelect: () => void
}) {
    return (
        <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={props.selected}
            onClick={props.onSelect}
            className={cn(
                'flex w-full items-center gap-2 rounded-lg py-2 pl-2.5 pr-2 text-left text-sm transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                props.selected && 'text-[var(--app-link)]'
            )}
        >
            <span className="flex h-5 w-4 shrink-0 items-center justify-center text-[var(--app-link)]">
                {props.selected ? <CheckIcon className="h-4 w-4" /> : null}
            </span>
            <span className="min-w-0 truncate whitespace-nowrap">{props.label}</span>
        </button>
    )
}

// Clamp the menu to the usable space below the trigger. The legacy right
// alignment remains available for callers that need it; session menus use
// centered positioning and are limited by the full usable viewport width.
// Safe-area insets shrink usable space on notched devices.
const MENU_VIEWPORT_MARGIN_PX = 8
const MENU_TOP_GAP_PX = 4 // mt-1

export function getCenteredFilterMenuLeft(
    anchor: { left: number; width: number },
    menuWidth: number,
    viewportWidth: number,
    margin = MENU_VIEWPORT_MARGIN_PX
): number {
    const width = Math.max(0, menuWidth)
    const desiredLeft = anchor.left + anchor.width / 2 - width / 2
    const minLeft = margin
    const maxLeft = Math.max(minLeft, viewportWidth - margin - width)
    const clampedLeft = Math.min(maxLeft, Math.max(minLeft, desiredLeft))
    return clampedLeft - anchor.left
}

export function getMachineFilterMenuClampStyle(
    anchor: { right: number; bottom: number },
    options: { widthCap?: string | null; horizontal?: 'right' | 'center' } = {}
): CSSProperties {
    const widthExpression = options.horizontal === 'center'
        ? 'calc(100vw - '
            + MENU_VIEWPORT_MARGIN_PX * 2
            + 'px - env(safe-area-inset-left) - env(safe-area-inset-right))'
        : 'calc('
            + anchor.right
            + 'px - '
            + MENU_VIEWPORT_MARGIN_PX
            + 'px - env(safe-area-inset-left))'
    const maxWidth = options.widthCap === null
        ? widthExpression
        : 'min(' + (options.widthCap ?? '16rem') + ', ' + widthExpression + ')'
    return {
        maxWidth,
        maxHeight: `min(20rem, calc(var(--tg-viewport-stable-height, var(--app-viewport-height, 100dvh)) - ${anchor.bottom + MENU_TOP_GAP_PX}px - ${MENU_VIEWPORT_MARGIN_PX}px - env(safe-area-inset-bottom)))`
    }
}

// Mobile (below md) counterpart of MachineFilterBar: collapses the machine
// filter into a single header icon button with a dropdown, so the chip row
// does not consume vertical space on small screens. A blue dot mirrors the
// search/date picker's active-filter indicator; health metrics render inline
// because hover tooltips are unavailable on touch devices.
export function MachineFilterMenu(props: {
    machines: MachineFilterItem[]
    totalCount: number
    value: string | null
    onChange: (id: string | null) => void
    sessionFilter?: SessionListFilterState
    onSessionFilterChange?: (value: SessionListFilterState) => void
    customStart?: string
    customEnd?: string
    sessionActivityDates?: ReadonlySet<string>
    onDateRangeChange?: (start: string, end: string) => void
    datePickerCenterRef?: RefObject<HTMLElement | null>
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const wrapperRef = useRef<HTMLDivElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const dateFilterButtonRef = useRef<HTMLButtonElement>(null)
    const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)
    const [menuLeft, setMenuLeft] = useState<number | null>(null)
    const [datePickerOpen, setDatePickerOpen] = useState(false)
    const hasSessionFilter = props.sessionFilter !== undefined && props.onSessionFilterChange !== undefined
    const hasDateFilter = props.customStart !== undefined
        && props.customEnd !== undefined
        && props.sessionActivityDates !== undefined
        && props.onDateRangeChange !== undefined
    const triggerLabel = hasSessionFilter ? t('sessions.filter.label') : t('sessions.machineFilter.label')

    const close = useCallback(() => {
        setOpen(false)
        setDatePickerOpen(false)
        triggerRef.current?.focus()
    }, [])

    const closeDatePicker = useCallback(() => {
        setDatePickerOpen(false)
        dateFilterButtonRef.current?.focus()
    }, [])

    const select = (id: string | null) => {
        props.onChange(id)
        close()
    }

    const selectSessionFilter = (value: Exclude<SessionListFilter, 'all'>) => {
        if (!props.onSessionFilterChange) return
        setDatePickerOpen(false)
        props.onSessionFilterChange(toggleSessionListFilter(props.sessionFilter!, value))
    }

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

    // Focus the selected (or first) row on open; Escape closes and Arrow keys
    // move between rows, matching SessionActionMenu's keyboard behavior.
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
    }, [open, close])

    return (
        <div ref={wrapperRef} className="relative shrink-0 md:hidden">
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen(value => !value)}
                aria-label={triggerLabel}
                title={triggerLabel}
                aria-haspopup="menu"
                aria-expanded={open}
                className="relative flex rounded-full p-1.5 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            >
                <FilterIcon className="h-5 w-5" />
                {props.value !== null
                    || (props.sessionFilter !== undefined && (props.sessionFilter.unread || props.sessionFilter.scratchlist))
                    || (hasDateFilter && Boolean(props.customStart && props.customEnd)) ? (
                    <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--app-link)]" />
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
                        aria-label={triggerLabel}
                        style={{
                            ...(anchor
                                ? getMachineFilterMenuClampStyle(anchor, { widthCap: null, horizontal: 'center' })
                                : {}),
                            left: menuLeft === null ? '50%' : menuLeft,
                            transform: menuLeft === null ? 'translateX(-50%)' : 'none'
                        }}
                        className="absolute top-full z-30 mt-1 max-h-80 w-max max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-xl"
                    >
                        {hasSessionFilter ? (
                            <>
                                <div role="group" aria-label={t('sessions.filter.section')}>
                                    <div className="px-2.5 pb-1 pt-1 text-xs font-medium text-[var(--app-hint)]">
                                        {t('sessions.filter.section')}
                                    </div>
                                    {SESSION_LIST_FILTER_OPTIONS.map((option) => (
                                        <Fragment key={option.value}>
                                            <SessionFilterMenuRow
                                                label={t(option.labelKey)}
                                                selected={isSessionListFilterSelected(props.sessionFilter!, option.value)}
                                                onSelect={() => selectSessionFilter(option.value)}
                                            />
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
                                    ))}
                                </div>
                                <div role="separator" className="my-1 border-t border-[var(--app-border)]" />
                                <div role="group" aria-label={t('sessions.machineFilter.label')}>
                                    <div className="px-2.5 pb-1 pt-1 text-xs font-medium text-[var(--app-hint)]">
                                        {t('sessions.machineFilter.label')}
                                    </div>
                                    <MachineFilterMenuRow
                                        label={t('sessions.machineFilter.all')}
                                        count={props.totalCount}
                                        selected={props.value === null}
                                        healthPresentation={null}
                                        onSelect={() => select(null)}
                                    />
                                    {props.machines.map((machine) => (
                                        <MachineFilterMenuRow
                                            key={machine.id}
                                            label={machine.label}
                                            count={machine.sessionCount}
                                            selected={props.value === machine.id}
                                            healthPresentation={machine.healthPresentation}
                                            onSelect={() => select(machine.id)}
                                        />
                                    ))}
                                </div>
                            </>
                        ) : (
                            <>
                                {hasDateFilter ? (
                                    <SessionDateFilterMenuRow
                                        start={props.customStart!}
                                        end={props.customEnd!}
                                        expanded={datePickerOpen}
                                        buttonRef={dateFilterButtonRef}
                                        onSelect={() => setDatePickerOpen(value => !value)}
                                    />
                                ) : null}
                                <MachineFilterMenuRow
                                    label={t('sessions.machineFilter.all')}
                                    count={props.totalCount}
                                    selected={props.value === null}
                                    healthPresentation={null}
                                    onSelect={() => select(null)}
                                />
                                {props.machines.map((machine) => (
                                    <MachineFilterMenuRow
                                        key={machine.id}
                                        label={machine.label}
                                        count={machine.sessionCount}
                                        selected={props.value === machine.id}
                                        healthPresentation={machine.healthPresentation}
                                        onSelect={() => select(machine.id)}
                                    />
                                ))}
                            </>
                        )}
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
