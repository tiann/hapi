import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Lightweight CSS-driven tooltip used by the session list to surface "why is
 * this indicator showing?" copy on hover/focus. Pure CSS reveal (no portal,
 * no positioning JS) keeps the component cheap and avoids z-index surprises
 * inside the session-row `<button>`.
 *
 * Touch devices get the `aria-label` (announced) but no visible bubble — the
 * row is tap-to-open, so the dot deliberately does not capture touch events.
 *
 * Layout: tooltip flips to top-anchored when `side='top'`, otherwise hangs
 * below. Content is wrapped to `max-w-[14rem]` so long tool names don't blow
 * out the sidebar.
 */
export function HoverTooltip(props: {
    /** Plain-text label used for `aria-label` and screen readers. */
    label: string
    /** Visible target element (the dot, the icon, etc.). */
    target: ReactNode
    /** Rich tooltip content. Plain text or a small fragment with headings/lists. */
    children: ReactNode
    side?: 'top' | 'bottom'
    align?: 'start' | 'center' | 'end'
    className?: string
}) {
    const id = useId()
    const side = props.side ?? 'bottom'
    const align = props.align ?? 'center'

    const alignClasses =
        align === 'start' ? 'left-0'
        : align === 'end' ? 'right-0'
        : 'left-1/2 -translate-x-1/2'

    return (
        <span className={cn('relative inline-flex group', props.className)}>
            <span
                aria-describedby={id}
                aria-label={props.label}
                className="inline-flex"
            >
                {props.target}
            </span>
            <span
                role="tooltip"
                id={id}
                className={cn(
                    'pointer-events-none absolute z-30 max-w-[14rem] whitespace-normal',
                    'rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]',
                    'px-2 py-1 text-xs leading-snug text-[var(--app-fg)] shadow-md',
                    side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1',
                    alignClasses,
                    'opacity-0 invisible',
                    'group-hover:opacity-100 group-hover:visible',
                    'group-focus-within:opacity-100 group-focus-within:visible',
                    'transition-opacity duration-100'
                )}
            >
                {props.children}
            </span>
        </span>
    )
}
