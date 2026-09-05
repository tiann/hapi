import { useCallback, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react'
import { CheckIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

export function CalendarIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M16 3v4M8 3v4M3 10h18" />
        </svg>
    )
}

export function parseLocalDate(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) return null
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const date = new Date(year, month - 1, day)
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
    return date
}

export function formatDateValue(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return [year, month, day].join('-')
}

export function SessionDateFilterMenuRow(props: {
    start: string
    end: string
    expanded: boolean
    buttonRef?: Ref<HTMLButtonElement>
    onSelect: () => void
}) {
    const { t } = useTranslation()
    const hasDateRange = Boolean(props.start && props.end)
    const label = hasDateRange
        ? t('sessions.filter.date') + ': ' + props.start + ' – ' + props.end
        : t('sessions.filter.date')

    return (
        <button
            ref={props.buttonRef}
            type="button"
            role="menuitemcheckbox"
            aria-checked={hasDateRange}
            aria-haspopup="dialog"
            aria-expanded={props.expanded}
            onClick={props.onSelect}
            className={cn(
                'flex w-full items-center gap-2 rounded-lg py-2 pl-2.5 pr-2 text-left text-sm transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                hasDateRange && 'text-[var(--app-link)]'
            )}
        >
            <span className="flex h-5 w-4 shrink-0 items-center justify-center text-[var(--app-link)]">
                {hasDateRange ? <CheckIcon className="h-4 w-4" /> : null}
            </span>
            <span className="min-w-0 flex-auto truncate whitespace-nowrap">{label}</span>
        </button>
    )
}

export type SessionDatePickerPosition = {
    top: number
    left: number
    width: number
    maxHeight: number
}

export function getSessionDatePickerPosition(
    anchor: { top: number; bottom: number; right: number; center?: number },
    picker: { width: number; height: number },
    viewport: { width: number; height: number },
    margin = 8,
    gap = 8
): SessionDatePickerPosition {
    const width = Math.min(picker.width, Math.max(0, viewport.width - margin * 2))
    const maxLeft = Math.max(margin, viewport.width - margin - width)
    const desiredLeft = anchor.center === undefined
        ? anchor.right - width
        : anchor.center - width / 2
    const left = Math.min(maxLeft, Math.max(margin, desiredLeft))
    const maxHeight = Math.min(picker.height, Math.max(0, viewport.height - margin * 2))

    let top = anchor.bottom + gap
    if (top + maxHeight > viewport.height - margin) {
        const above = anchor.top - maxHeight - gap
        top = above >= margin
            ? above
            : Math.max(margin, viewport.height - margin - maxHeight)
    }

    return { top, left, width, maxHeight }
}

export function SessionDateRangePicker(props: {
    start: string
    end: string
    sessionActivityDates: ReadonlySet<string>
    onChange: (start: string, end: string) => void
    onClear: () => void
    onClose: () => void
    align: 'left' | 'right'
    anchorRef?: RefObject<HTMLElement | null>
    horizontalCenterRef?: RefObject<HTMLElement | null>
}) {
    const { t } = useTranslation()
    const initialDate = parseLocalDate(props.start) ?? new Date()
    const [visibleMonth, setVisibleMonth] = useState(() => new Date(initialDate.getFullYear(), initialDate.getMonth(), 1))
    const pickerRef = useRef<HTMLDivElement>(null)
    const [position, setPosition] = useState<SessionDatePickerPosition | null>(null)
    const today = formatDateValue(new Date())
    const firstWeekday = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1).getDay()
    const daysInMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate()
    const weekdays = Array.from({ length: 7 }, (_, day) => (
        new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(2026, 5, 7 + day))
    ))

    const selectDate = (value: string) => {
        if (!props.start || props.end) {
            props.onChange(value, '')
            return
        }
        props.onChange(value < props.start ? value : props.start, value < props.start ? props.start : value)
        props.onClose()
    }

    const updatePosition = useCallback(() => {
        const anchor = props.anchorRef?.current
        const picker = pickerRef.current
        if (!anchor || !picker) return

        const anchorRect = anchor.getBoundingClientRect()
        const horizontalCenterRect = props.horizontalCenterRef?.current?.getBoundingClientRect()
        const pickerRect = picker.getBoundingClientRect()
        setPosition(getSessionDatePickerPosition(
            {
                top: anchorRect.top,
                bottom: anchorRect.bottom,
                right: anchorRect.right,
                center: horizontalCenterRect
                    ? horizontalCenterRect.left + horizontalCenterRect.width / 2
                    : undefined
            },
            {
                width: pickerRect.width,
                height: pickerRect.height
            },
            {
                width: window.innerWidth,
                height: window.innerHeight
            }
        ))
    }, [props.anchorRef, props.horizontalCenterRef])

    useLayoutEffect(() => {
        if (!props.anchorRef) return

        updatePosition()
        const frame = window.requestAnimationFrame(updatePosition)
        const anchor = props.anchorRef.current
        const horizontalCenter = props.horizontalCenterRef?.current
        const resizeObserver = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(updatePosition)
        if (anchor) resizeObserver?.observe(anchor)
        if (horizontalCenter && horizontalCenter !== anchor) resizeObserver?.observe(horizontalCenter)
        window.addEventListener('resize', updatePosition)
        window.addEventListener('scroll', updatePosition, true)
        return () => {
            window.cancelAnimationFrame(frame)
            resizeObserver?.disconnect()
            window.removeEventListener('resize', updatePosition)
            window.removeEventListener('scroll', updatePosition, true)
        }
    }, [props.anchorRef, updatePosition, visibleMonth])

    const isFloating = props.anchorRef !== undefined

    return (
        <div
            role="dialog"
            aria-label={t('sessions.timeFilter.label')}
            ref={pickerRef}
            style={isFloating ? {
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                width: position?.width,
                maxHeight: position?.maxHeight ?? 'calc(100dvh - 1rem)',
                visibility: position ? 'visible' : 'hidden'
            } : undefined}
            className={cn(
                isFloating
                    ? 'fixed z-40 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto'
                    : 'absolute top-full z-30 mt-2 w-72',
                'rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-xl',
                !isFloating && (props.align === 'left' ? 'left-0' : 'right-0')
            )}
        >
            <div className="mb-2 flex items-center justify-between">
                <button
                    type="button"
                    onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1))}
                    className="rounded-lg p-1.5 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    aria-label={t('sessions.timeFilter.previousMonth')}
                >
                    <span aria-hidden="true">‹</span>
                </button>
                <div className="text-sm font-medium">
                    {visibleMonth.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}
                </div>
                <button
                    type="button"
                    onClick={() => setVisibleMonth(new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1))}
                    className="rounded-lg p-1.5 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    aria-label={t('sessions.timeFilter.nextMonth')}
                >
                    <span aria-hidden="true">›</span>
                </button>
            </div>
            <div className="mb-1 grid grid-cols-7 text-center text-[10px] text-[var(--app-hint)]">
                {weekdays.map((weekday, index) => <div key={weekday + '-' + index} className="py-1">{weekday}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
                {Array.from({ length: firstWeekday }, (_, index) => <div key={'blank-' + index} />)}
                {Array.from({ length: daysInMonth }, (_, index) => {
                    const date = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), index + 1)
                    const value = formatDateValue(date)
                    const isToday = value === today
                    const isEndpoint = value === props.start || value === props.end
                    const isInRange = Boolean(props.start && props.end && value > props.start && value < props.end)
                    const hasSessionActivity = props.sessionActivityDates.has(value)
                    const dateLabel = date.toLocaleDateString()
                    const activityLabel = hasSessionActivity
                        ? t('sessions.timeFilter.dayWithActivity', { date: dateLabel })
                        : dateLabel
                    return (
                        <button
                            key={value}
                            type="button"
                            onClick={() => selectDate(value)}
                            aria-label={activityLabel}
                            aria-current={isToday ? 'date' : undefined}
                            title={hasSessionActivity ? activityLabel : undefined}
                            className={cn(
                                'h-8 rounded-lg text-xs transition-colors',
                                isEndpoint && 'bg-[var(--app-button)] text-[var(--app-button-text)]',
                                isInRange && 'bg-[var(--app-link)]/15 text-[var(--app-link)]',
                                !isEndpoint && !isInRange && isToday && 'bg-[var(--app-subtle-bg)]',
                                !isEndpoint && !isInRange && hasSessionActivity && 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]',
                                !isEndpoint && !isInRange && !hasSessionActivity && 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]'
                            )}
                        >
                            {index + 1}
                        </button>
                    )
                })}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-[var(--app-divider)] pt-2 text-xs">
                <span className="text-[var(--app-hint)]">
                    {!props.start
                        ? t('sessions.timeFilter.pickStart')
                        : !props.end
                            ? t('sessions.timeFilter.pickEnd')
                            : props.start + ' – ' + props.end}
                </span>
                {props.start ? (
                    <button type="button" onClick={props.onClear} className="text-[var(--app-link)]">
                        {t('sessions.timeFilter.clear')}
                    </button>
                ) : null}
            </div>
        </div>
    )
}
