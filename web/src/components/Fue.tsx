import type { CSSProperties, ReactNode, RefObject } from 'react'
import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * FueDot — small attention-getter for new features.
 *
 * Goes on top of an existing affordance (button, link, icon). The host
 * element should be `position: relative` so this absolute child anchors
 * to it. Pulses while `pulsing` is true to draw the eye, then settles
 * to a static dot once the user has engaged with it (the parent's
 * useFue hook flips `pulsing` to false during the acknowledge window).
 *
 * Visual: 8px circle, defaulting to amber. Caller can override `color`
 * with any Tailwind bg-* class to match the feature's theme.
 *
 * NOT a counter. The entry counter is a separate badge component — by
 * design FUE marker and entry-count badge are mutually exclusive (see
 * the wiring in ComposerButtons): user is either being onboarded OR
 * being told how many items they have stashed, never both.
 */
export function FueDot(props: {
    pulsing?: boolean
    color?: string
    ariaLabel?: string
    className?: string
}) {
    const color = props.color ?? 'bg-amber-500'
    return (
        <span
            role={props.ariaLabel ? 'status' : undefined}
            aria-label={props.ariaLabel}
            aria-hidden={props.ariaLabel ? undefined : true}
            className={`absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ${color} shadow-sm ${props.pulsing ? 'animate-pulse' : ''} ${props.className ?? ''}`.trim()}
        />
    )
}

/**
 * Compute viewport-clamped placement for a callout anchored above its
 * affordance. Pure function so it's testable.
 *
 * Strategy:
 * - Vertical: float above the anchor with `gap` px of breathing room.
 *   If there's not enough room above, drop below instead.
 * - Horizontal: align callout left edge with anchor left edge by default
 *   (the affordance is typically left-justified in a toolbar so the
 *   callout extends rightward to stay on-screen). Clamp to viewport
 *   bounds with `margin` px of padding.
 */
export function computeFueCalloutPlacement(params: {
    anchor: { top: number; right: number; bottom: number; left: number }
    panelWidth: number
    panelHeight: number
    viewport: { width: number; height: number; offsetTop?: number; offsetLeft?: number }
    gap?: number
    margin?: number
}): { top: number; left: number; placement: 'above' | 'below' } {
    const gap = params.gap ?? 8
    const margin = params.margin ?? 8
    const vTop = params.viewport.offsetTop ?? 0
    const vLeft = params.viewport.offsetLeft ?? 0
    const vRight = vLeft + params.viewport.width
    const vBottom = vTop + params.viewport.height

    const minLeft = vLeft + margin
    const maxLeft = Math.max(minLeft, vRight - params.panelWidth - margin)
    const left = Math.min(Math.max(params.anchor.left, minLeft), maxLeft)

    const spaceAbove = params.anchor.top - gap - (vTop + margin)
    const placement: 'above' | 'below' =
        spaceAbove >= params.panelHeight ? 'above' : 'below'

    const top =
        placement === 'above'
            ? Math.max(vTop + margin, params.anchor.top - gap - params.panelHeight)
            : Math.min(
                  vBottom - margin - params.panelHeight,
                  params.anchor.bottom + gap
              )

    return { top, left, placement }
}

/**
 * FueCallout — small popover that explains a feature on first reveal.
 *
 * Renders into a portal at document.body so it escapes any
 * `overflow: hidden` ancestor (the composer toolbar lives inside one,
 * which clips the popover otherwise). Position is computed from the
 * anchor's bounding rect on mount and on viewport changes.
 *
 * Lifetime is owned by the parent (typically by useFue's `status`):
 * mount when `status === 'engaging'`, unmount when status becomes
 * `acknowledged` or the user hits the dismiss button. The 5-second
 * auto-acknowledge timer lives in useFue, so this component just renders.
 */
export function FueCallout(props: {
    title: string
    body: ReactNode
    /** Called when the user clicks "Got it" or the X. The callout requires
     *  affirmative action — there is no auto-timeout. Reading speed varies
     *  and silently disappearing popovers undercut user trust. */
    onDismiss: () => void
    /** Label for the affirmative "Got it" button. Defaults to "Got it". */
    dismissLabel?: string
    /** Aria label for the small X close button. Defaults to "Dismiss". */
    closeAriaLabel?: string
    anchorRef: RefObject<HTMLElement | null>
    /** Override the default panel width. */
    width?: number
    style?: CSSProperties
}) {
    const panelWidth = props.width ?? 256
    const [pos, setPos] = useState<{
        top: number
        left: number
        placement: 'above' | 'below'
    } | null>(null)

    // Esc-to-dismiss for keyboard users.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') props.onDismiss()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [props])

    // Position once the anchor is mounted; re-position on viewport changes.
    // useLayoutEffect so first paint already has correct position
    // (avoids a flash at 0,0).
    useLayoutEffect(() => {
        const anchor = props.anchorRef.current
        if (!anchor) return

        function measure() {
            const a = props.anchorRef.current
            if (!a) return
            const rect = a.getBoundingClientRect()
            const vp = window.visualViewport
            // Estimate panel height before render — close enough for clamping;
            // the actual layout adapts via Tailwind classes anyway.
            const panelHeight = 96
            setPos(
                computeFueCalloutPlacement({
                    anchor: rect,
                    panelWidth,
                    panelHeight,
                    viewport: {
                        width: vp?.width ?? window.innerWidth,
                        height: vp?.height ?? window.innerHeight,
                        offsetLeft: vp?.offsetLeft ?? 0,
                        offsetTop: vp?.offsetTop ?? 0,
                    },
                })
            )
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
    }, [props.anchorRef, panelWidth])

    if (typeof document === 'undefined') return null

    const node = (
        <div
            role="dialog"
            aria-label={props.title}
            style={
                pos
                    ? {
                          position: 'fixed',
                          top: pos.top,
                          left: pos.left,
                          width: panelWidth,
                          ...props.style,
                      }
                    : { position: 'fixed', visibility: 'hidden' }
            }
            // Solid theme-aware bg + solid amber border. The badge-warning CSS
            // vars are alpha 0.2 (designed to layer over chat content); using
            // them here made the popover translucent and unreadable when the
            // scratchlist drawer (same vars) was open behind it.
            className="z-[60] rounded-lg border-2 border-amber-500 bg-[var(--app-bg)] shadow-2xl p-3 text-xs text-[var(--app-fg)]"
        >
            <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                    <div className="font-semibold mb-1 text-amber-500">
                        {props.title}
                    </div>
                    <div className="text-[var(--app-fg)] leading-snug">
                        {props.body}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={props.onDismiss}
                    aria-label={props.closeAriaLabel ?? 'Dismiss'}
                    className="flex h-5 w-5 -mr-1 -mt-1 items-center justify-center rounded-full text-[var(--app-fg)]/60 hover:bg-[var(--app-fg)]/10 hover:text-[var(--app-fg)]"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>
            </div>
            {/* Affirmative-action dismiss. No auto-timeout: reading speed
                varies, and a popover that disappears on its own undercuts
                the "user is in control" model. */}
            <div className="mt-3 flex justify-end">
                <button
                    type="button"
                    onClick={props.onDismiss}
                    className="rounded-md bg-amber-500 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                >
                    {props.dismissLabel ?? 'Got it'}
                </button>
            </div>
        </div>
    )

    return createPortal(node, document.body)
}
