import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { MachineHealthPresentation } from '@/lib/machineHealth'
import { MachineHealthTooltipBody } from '@/components/MachineHealthIndicator'
import { HoverTooltip } from '@/components/HoverTooltip'
import { CheckIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
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

function FilterIcon(props: { className?: string }) {
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

// Single-machine counterpart of MachineFilterBar: with nothing to filter,
// chips would be meaningless, but the machine's health and session count
// still belong in the sidebar. Renders a compact non-interactive row —
// health metrics are inline so touch layouts need no hover, and pointer
// users get the same capacity popup as the filter chips.
export function MachineSummaryRow(props: { machine: MachineFilterItem }) {
    const tooltipId = useId()
    const hasHealth = Boolean(props.machine.healthPresentation?.metrics.length)

    const content = (
        <span
            className="flex min-w-0 items-center gap-1.5"
            aria-describedby={hasHealth ? tooltipId : undefined}
        >
            <span className="max-w-32 truncate text-[var(--app-fg)]">{props.machine.label}</span>
            <span className="shrink-0 tabular-nums text-[var(--app-hint)]">({props.machine.sessionCount})</span>
            {hasHealth ? (
                <span className="min-w-0 truncate tabular-nums text-[var(--app-hint)]">
                    {props.machine.healthPresentation!.metrics
                        .map((metric) => `${metric.shortLabel} ${metric.percent}%`)
                        .join(' · ')}
                </span>
            ) : null}
        </span>
    )

    return (
        <div className="flex items-center px-2 pb-2 text-xs">
            {hasHealth ? (
                // Same popup treatment as the filter chips: hidden below md
                // (the inline metrics above already cover touch layouts).
                <HoverTooltip
                    id={tooltipId}
                    target={content}
                    side="bottom"
                    align="start"
                    tooltipClassName="pointer-events-auto before:absolute before:inset-x-0 before:-top-1 before:h-1 before:content-[''] px-3 py-2 min-w-[16rem] max-md:hidden"
                >
                    <MachineHealthTooltipBody presentation={props.machine.healthPresentation!} />
                </HoverTooltip>
            ) : content}
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

// Clamp the menu to the space actually remaining left of/below the trigger
// (the menu is right-anchored to the trigger): the rem-based design caps
// (w-64 / max-h-80) grow with the font-scale setting, and safe-area insets
// shrink usable space on notched devices. The height chain mirrors the body
// sizing in index.css.
const MENU_VIEWPORT_MARGIN_PX = 8
const MENU_TOP_GAP_PX = 4 // mt-1

export function getMachineFilterMenuClampStyle(anchor: { right: number; bottom: number }): CSSProperties {
    return {
        maxWidth: `min(16rem, calc(${anchor.right}px - ${MENU_VIEWPORT_MARGIN_PX}px - env(safe-area-inset-left)))`,
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
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const wrapperRef = useRef<HTMLDivElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)

    const close = useCallback(() => {
        setOpen(false)
        triggerRef.current?.focus()
    }, [])

    const select = (id: string | null) => {
        props.onChange(id)
        close()
    }

    useLayoutEffect(() => {
        if (!open) {
            setAnchor(null)
            return
        }
        const updateAnchor = () => {
            const rect = wrapperRef.current?.getBoundingClientRect()
            if (!rect) return
            setAnchor({ right: rect.right, bottom: rect.bottom })
        }
        updateAnchor()
        window.addEventListener('resize', updateAnchor)
        return () => window.removeEventListener('resize', updateAnchor)
    }, [open])

    // Focus the selected (or first) row on open; Escape closes and Arrow keys
    // move between rows, matching SessionActionMenu's keyboard behavior.
    useEffect(() => {
        if (!open) return

        const frame = window.requestAnimationFrame(() => {
            const selected = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
            const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')
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
                menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []
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
                aria-label={t('sessions.machineFilter.label')}
                title={t('sessions.machineFilter.label')}
                aria-haspopup="menu"
                aria-expanded={open}
                className="relative flex rounded-full p-1.5 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            >
                <FilterIcon className="h-5 w-5" />
                {props.value !== null ? (
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
                        aria-label={t('sessions.machineFilter.label')}
                        style={anchor ? getMachineFilterMenuClampStyle(anchor) : undefined}
                        className="absolute right-0 top-full z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-xl"
                    >
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
            ) : null}
        </div>
    )
}
