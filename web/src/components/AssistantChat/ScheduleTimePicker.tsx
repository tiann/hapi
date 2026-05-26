import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from '@/lib/use-translation'

// ---------------------------------------------------------------------------
// PendingSchedule — discriminated union for "what the user chose"
// ---------------------------------------------------------------------------

/**
 * Represents a schedule selection before it is resolved to an absolute epoch-ms.
 *
 * - preset: user clicked a relative preset (e.g. '+5m').  The absolute time is
 *   computed at send time (Date.now() + delay) so "5 minutes from now" always
 *   means 5 minutes from when the user hits Send, not when they clicked the preset.
 * - absolute: user picked a specific datetime-local value.  Stored as epoch-ms;
 *   unchanged at send time.
 */
export type PendingSchedule =
    | { type: 'preset'; preset: '+5m' | '+30m' | '+1h' | '+4h' }
    | { type: 'absolute'; ms: number }

/**
 * Convert a PendingSchedule to an absolute epoch-ms at send time.
 * Returns null if pending is null.
 *
 * For 'preset' entries the base time is sendNow (the moment the user hits Send),
 * so "5 minutes from now" is always relative to the actual send action.
 * For 'absolute' entries the stored ms value is returned unchanged.
 */
export function resolvePendingSchedule(pending: PendingSchedule | null, sendNow: number): number | null {
    if (pending === null) return null
    if (pending.type === 'preset') return parsePreset(pending.preset, sendNow)
    return pending.ms
}

// ---------------------------------------------------------------------------
// Pure utility functions (exported for unit testing)
// ---------------------------------------------------------------------------

/** Parse a preset string like '+5m', '+30m', '+1h', '+4h' into an epoch-ms timestamp. */
export function parsePreset(preset: string, now: number): number {
    if (preset === '+5m') return now + 5 * 60 * 1000
    if (preset === '+30m') return now + 30 * 60 * 1000
    if (preset === '+1h') return now + 60 * 60 * 1000
    if (preset === '+4h') return now + 4 * 60 * 60 * 1000
    throw new Error(`Unknown preset: ${preset}`)
}

/** Clamp an epoch-ms value so it does not exceed now + maxDays days. */
export function clampToMaxDays(value: number, now: number, maxDays: number): number {
    const max = now + maxDays * 24 * 60 * 60 * 1000
    return Math.min(value, max)
}

/** Validate a specific datetime (epoch ms) against now.
 * Returns null if valid, or a translation key string if invalid.
 *
 * A 30-second grace period is allowed for values slightly in the past:
 * datetime-local inputs have minute resolution, so the selected minute can
 * become "in the past" by the time the user clicks Submit.  This avoids a
 * frustrating stale-invalid UX with no visible error cause. */
export function validateSpecificDatetime(
    value: number,
    now: number
): 'scheduleErrorPast' | 'scheduleErrorTooFar' | null {
    const GRACE_MS = 30_000 // 30 seconds
    if (value < now - GRACE_MS) return 'scheduleErrorPast'
    const maxFuture = now + 7 * 24 * 60 * 60 * 1000
    if (value > maxFuture) return 'scheduleErrorTooFar'
    return null
}

type RectLike = Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left'>

export type SchedulePickerViewport = {
    width: number
    height: number
    offsetTop?: number
    offsetLeft?: number
}

export type SchedulePickerPlacement = {
    top: number
    left: number
    maxHeight: number
    placement: 'above' | 'below'
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}

export function computeSchedulePickerPlacement(params: {
    anchor: RectLike
    panelWidth: number
    panelHeight: number
    viewport: SchedulePickerViewport
    margin?: number
    gap?: number
}): SchedulePickerPlacement {
    const margin = params.margin ?? 8
    const gap = params.gap ?? 8
    const viewportLeft = params.viewport.offsetLeft ?? 0
    const viewportTop = params.viewport.offsetTop ?? 0
    const viewportRight = viewportLeft + params.viewport.width
    const viewportBottom = viewportTop + params.viewport.height

    const panelWidth = Math.min(params.panelWidth, Math.max(0, params.viewport.width - margin * 2))
    const minLeft = viewportLeft + margin
    const maxLeft = viewportRight - panelWidth - margin
    const left = clamp(params.anchor.left, minLeft, Math.max(minLeft, maxLeft))

    const spaceAbove = params.anchor.top - gap - (viewportTop + margin)
    const spaceBelow = viewportBottom - margin - (params.anchor.bottom + gap)
    const fitsAbove = params.panelHeight <= spaceAbove
    const fitsBelow = params.panelHeight <= spaceBelow

    if (fitsAbove || (!fitsBelow && spaceAbove >= spaceBelow)) {
        const maxHeight = Math.max(0, Math.min(params.panelHeight, spaceAbove))
        return {
            placement: 'above',
            top: Math.max(viewportTop + margin, params.anchor.top - gap - maxHeight),
            left,
            maxHeight,
        }
    }

    const maxHeight = Math.max(0, Math.min(params.panelHeight, spaceBelow))
    return {
        placement: 'below',
        top: params.anchor.bottom + gap,
        left,
        maxHeight,
    }
}

// ---------------------------------------------------------------------------
// Relative presets
// ---------------------------------------------------------------------------

const PRESETS = ['+5m', '+30m', '+1h', '+4h'] as const
type Preset = typeof PRESETS[number]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ScheduleTimePickerProps {
    /** Called with a PendingSchedule when user confirms a schedule selection. */
    onSchedule: (pending: PendingSchedule) => void
    /** Called when the panel should close without scheduling. */
    onClose: () => void
    /**
     * The anchor element (the clock button). Used to position the panel with
     * `position: fixed` so it escapes any `overflow: hidden` ancestor.
     */
    anchorRef: React.RefObject<HTMLButtonElement | null>
    /** Currently active pending schedule, used to highlight the selected preset. */
    pendingSchedule?: PendingSchedule | null
}

export function ScheduleTimePicker({ onSchedule, onClose, anchorRef, pendingSchedule }: ScheduleTimePickerProps) {
    const { t } = useTranslation()
    const [tab, setTab] = useState<'relative' | 'specific'>('relative')
    const [specificValue, setSpecificValue] = useState('')
    const [specificError, setSpecificError] = useState<string | null>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const [pos, setPos] = useState<SchedulePickerPlacement | null>(null)
    const [isMobilePanel, setIsMobilePanel] = useState(false)
    const [isContentConstrained, setIsContentConstrained] = useState(false)

    // Compute fixed position and keep it inside the visual viewport. On mobile,
    // use a bottom panel instead of anchoring to the tiny toolbar button.
    useLayoutEffect(() => {
        function measure() {
            const anchor = anchorRef.current
            const panel = panelRef.current
            if (!anchor) return
            const mobile = window.matchMedia('(max-width: 640px), (pointer: coarse)').matches
            setIsMobilePanel(mobile)
            const fullHeight = (panel?.scrollHeight ?? (tab === 'specific' ? 260 : 180)) + 4
            if (mobile) {
                const viewportHeight = window.visualViewport?.height ?? window.innerHeight
                setIsContentConstrained(fullHeight > Math.min(viewportHeight * 0.85, viewportHeight - 24))
                setPos(null)
                return
            }
            const rect = anchor.getBoundingClientRect()
            const viewport = window.visualViewport
            const placement = computeSchedulePickerPlacement({
                anchor: rect,
                panelWidth: panel?.offsetWidth || 320,
                panelHeight: fullHeight,
                viewport: {
                    width: viewport?.width ?? window.innerWidth,
                    height: viewport?.height ?? window.innerHeight,
                    offsetLeft: viewport?.offsetLeft ?? 0,
                    offsetTop: viewport?.offsetTop ?? 0,
                },
            })
            setIsContentConstrained(placement.maxHeight < fullHeight)
            setPos(placement)
        }
        measure()
        window.addEventListener('resize', measure, { passive: true })
        window.addEventListener('scroll', measure, { passive: true, capture: true })
        window.visualViewport?.addEventListener('resize', measure, { passive: true })
        window.visualViewport?.addEventListener('scroll', measure, { passive: true })
        return () => {
            window.removeEventListener('resize', measure)
            window.removeEventListener('scroll', measure, true)
            window.visualViewport?.removeEventListener('resize', measure)
            window.visualViewport?.removeEventListener('scroll', measure)
        }
    // anchorRef is a useRef object — stable identity, so this effect runs once on mount.
    }, [anchorRef, tab])

    // Click-outside closes the panel.
    //
    // Anchor-button guard: the schedule button toggles open/closed via onClick.
    // pointerdown fires before click on the same gesture, so without this guard
    // a click on the anchor would (1) close the picker via the document listener,
    // then (2) reopen it via the button's onClick — making the button only able
    // to OPEN, never to close.  Skip pointerdown events whose target is inside
    // the anchor so the click handler is the sole toggle path.
    useEffect(() => {
        function handlePointerDown(e: PointerEvent) {
            const target = e.target as Node
            if (panelRef.current?.contains(target)) return
            if (anchorRef.current?.contains(target)) return
            onClose()
        }
        document.addEventListener('pointerdown', handlePointerDown)
        return () => document.removeEventListener('pointerdown', handlePointerDown)
    }, [onClose, anchorRef])

    // Compute max value for datetime-local input (7 days from now)
    const maxDatetimeLocal = (() => {
        const now = new Date()
        const max = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
        // Format: YYYY-MM-DDTHH:mm (datetime-local format, no seconds)
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${max.getFullYear()}-${pad(max.getMonth() + 1)}-${pad(max.getDate())}T${pad(max.getHours())}:${pad(max.getMinutes())}`
    })()

    const minDatetimeLocal = (() => {
        const now = new Date(Date.now() + 60 * 1000) // at least 1 min ahead
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
    })()

    const handlePresetClick = (preset: Preset) => {
        // Store the preset key only — absolute ms is computed at send time (send-time base).
        onSchedule({ type: 'preset', preset })
        onClose()
    }

    const handleSpecificSubmit = () => {
        if (!specificValue) return
        const parsed = new Date(specificValue).getTime()
        if (isNaN(parsed)) return
        const now = Date.now()
        const error = validateSpecificDatetime(parsed, now)
        if (error) {
            const errorKeyMap = {
                scheduleErrorPast: 'composer.scheduleErrorPast',
                scheduleErrorTooFar: 'composer.scheduleErrorTooFar',
            } as const
            setSpecificError(t(errorKeyMap[error]))
            return
        }
        onSchedule({ type: 'absolute', ms: parsed })
        onClose()
    }

    const handleSpecificChange = (value: string) => {
        setSpecificValue(value)
        if (specificError) setSpecificError(null)
    }

    const handleSpecificKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        event.stopPropagation()
        handleSpecificSubmit()
    }

    return (
        <div
            ref={panelRef}
            role="dialog"
            aria-label={t('composer.scheduleSend')}
            style={
                isMobilePanel
                    ? { position: 'fixed' }
                    : pos
                    ? { position: 'fixed', top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
                    : { position: 'fixed', visibility: 'hidden' }
            }
            className={
                isMobilePanel
                    ? `z-50 box-border max-h-[min(85dvh,calc(var(--app-viewport-height,100dvh)-24px))] ${isContentConstrained ? 'overflow-y-auto' : 'overflow-y-visible'} rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] sm:left-1/2 sm:right-auto sm:w-80 sm:-translate-x-1/2`
                    : `z-50 box-border w-80 max-w-[calc(100vw-16px)] ${isContentConstrained ? 'overflow-y-auto' : 'overflow-y-visible'} rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg`
            }
            onPointerDown={(e) => e.stopPropagation()}
        >
            {/* Header */}
            <div className="px-3 pt-3 pb-2">
                <p className="text-xs font-semibold text-[var(--app-hint)]">
                    {t('composer.scheduleSend')}
                </p>
            </div>

            {/* Tab buttons */}
            <div className="flex px-3 gap-1 mb-2">
                <button
                    type="button"
                    onClick={() => setTab('relative')}
                    className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                        tab === 'relative'
                            ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)]'
                            : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                    }`}
                >
                    {t('composer.scheduleRelativeTab')}
                </button>
                <button
                    type="button"
                    onClick={() => setTab('specific')}
                    className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                        tab === 'specific'
                            ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)]'
                            : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                    }`}
                >
                    {t('composer.scheduleSpecificTab')}
                </button>
            </div>

            {/* Tab content */}
            <div className="px-3 pb-3">
                {tab === 'relative' ? (
                    <div className="grid grid-cols-2 gap-1.5">
                        {PRESETS.map((preset) => {
                            const isSelected = pendingSchedule?.type === 'preset' && pendingSchedule.preset === preset
                            return (
                                <button
                                    key={preset}
                                    type="button"
                                    onClick={() => handlePresetClick(preset)}
                                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                                        isSelected
                                            ? 'border-blue-500 bg-blue-500 text-white'
                                            : 'border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] hover:border-[var(--app-link)]'
                                    }`}
                                >
                                    {preset}
                                </button>
                            )
                        })}
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        <input
                            type="datetime-local"
                            value={specificValue}
                            min={minDatetimeLocal}
                            max={maxDatetimeLocal}
                            onChange={(e) => handleSpecificChange(e.target.value)}
                            onKeyDown={handleSpecificKeyDown}
                            className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)]"
                        />
                        {specificError ? (
                            <p className="text-xs text-red-500">{specificError}</p>
                        ) : (
                            <p className="break-words text-xs text-[var(--app-hint)]">
                                {t('composer.scheduleSpecificHint')}
                            </p>
                        )}
                        <button
                            type="button"
                            disabled={!specificValue}
                            onClick={handleSpecificSubmit}
                            className="w-full rounded-lg bg-blue-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {t('composer.scheduleSend')}
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}
