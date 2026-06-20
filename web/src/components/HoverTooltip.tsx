import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Tailwind classes that reveal the bubble when a named parent row has :focus-visible. */
export const SESSION_ROW_TOOLTIP_FOCUS_CLASS =
    'group-focus-visible/session-row:opacity-100 group-focus-visible/session-row:visible'

/**
 * Lightweight CSS-driven tooltip used by the session list to surface "why is
 * this indicator showing?" copy on hover/focus. Pure CSS reveal (no portal,
 * no positioning JS) keeps the component cheap and avoids z-index surprises
 * inside the session-row `<button>`.
 *
 * Keyboard: the session-row `<button>` owns `aria-describedby` pointing at
 * this tooltip's `id`. Pass `revealOnParentFocusClass` (see
 * `SESSION_ROW_TOOLTIP_FOCUS_CLASS`) so the bubble is visible when the row
 * receives keyboard focus — an inner non-focusable wrapper cannot use
 * `:focus-within` for that.
 *
 * Mouse: local `group-hover` on this wrapper still reveals the bubble when
 * the pointer is over the dot/icon.
 *
 * Touch: no visible bubble — the row is tap-to-open.
 */
export function HoverTooltip(props: {
    /** Stable id for `aria-describedby` on the session-row button. */
    id: string
    /** Visible target element (the dot, the icon, etc.). */
    target: ReactNode
    /** Rich tooltip content. Plain text or a small fragment with headings/lists. */
    children: ReactNode
    side?: 'top' | 'bottom'
    align?: 'start' | 'center' | 'end'
    className?: string
    /** Parent-focus reveal classes (e.g. SESSION_ROW_TOOLTIP_FOCUS_CLASS). */
    revealOnParentFocusClass?: string
    /** Optional classes for the tooltip panel (e.g. wider popover). */
    tooltipClassName?: string
}) {
    const side = props.side ?? 'bottom'
    const align = props.align ?? 'center'

    const alignClasses =
        align === 'start' ? 'left-0'
        : align === 'end' ? 'right-0'
        : 'left-1/2 -translate-x-1/2'

    return (
        <span className={cn('relative inline-flex group', props.className)}>
            <span className="inline-flex">
                {props.target}
            </span>
            <span
                role="tooltip"
                id={props.id}
                className={cn(
                    'pointer-events-none absolute z-30 max-w-[14rem] whitespace-normal',
                    'rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)]',
                    'px-2 py-1 text-xs leading-snug text-[var(--app-fg)] shadow-lg',
                    side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1',
                    alignClasses,
                    'opacity-0 invisible',
                    'group-hover:opacity-100 group-hover:visible',
                    props.revealOnParentFocusClass,
                    props.tooltipClassName,
                    'transition-opacity duration-100'
                )}
            >
                {props.children}
            </span>
        </span>
    )
}

/** Convenience hook: `${base}-attention` / `${base}-schedule` ids for a row. */
export function useSessionRowTooltipIds(hasAttention: boolean, hasSchedule: boolean) {
    const base = useId()
    const attentionId = hasAttention ? `${base}-attention` : undefined
    const scheduleId = hasSchedule ? `${base}-schedule` : undefined
    const describedBy = [attentionId, scheduleId].filter(Boolean).join(' ') || undefined
    return { attentionId, scheduleId, describedBy }
}
