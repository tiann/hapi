import { useEffect, type RefObject } from 'react'

/**
 * How long one reveal attempt keeps correcting. A collapsed project animates
 * open over 0.25s (`.collapsible-panel` in `index.css`) and only reaches its
 * full scroll range at the end of that animation, so an attempt normally exits
 * earlier than this — as soon as the row is in view and the list has stopped
 * growing. An attempt that never finds the row does not end the reveal; the
 * list growing starts a fresh attempt.
 */
export const SCROLL_SELECTED_SESSION_SETTLE_MS = 500

/** Subpixel layout should not count as "the row is clipped". */
const EDGE_TOLERANCE_PX = 1

type Edges = { top: number; bottom: number }

/**
 * Row markers written by `SessionList`, scoped to the list's scroll container.
 * The id can be marked on an inner node of the row, so always measure the
 * `.session-list-item` shell rather than whatever carried the attribute.
 */
const SESSION_ROW_MARKER_SELECTOR = '[data-session-id]'
const SESSION_ROW_SELECTOR = '.session-list-item'

/** The `position: sticky` project header of the group a row belongs to. */
const SESSION_GROUP_SELECTOR = '[data-session-scroll-anchor]'
const SESSION_GROUP_HEADER_SELECTOR = ':scope > [data-session-group-header]'

/**
 * Smallest `scrollTop` delta that brings `row` into `viewport`, using
 * nearest-edge (`scrollIntoView({ block: 'nearest' })`) semantics: scroll the
 * row's nearest off-screen edge flush with the matching viewport edge, and
 * return `0` when the row already fits — or already spans the viewport, where
 * scrolling could not reveal any more of it.
 */
export function resolveSessionScrollDelta(viewport: Edges, row: Edges): number {
    const topDelta = row.top - viewport.top
    const bottomDelta = row.bottom - viewport.bottom
    if (topDelta < -EDGE_TOLERANCE_PX && bottomDelta <= EDGE_TOLERANCE_PX) return topDelta
    if (bottomDelta > EDGE_TOLERANCE_PX && topDelta >= -EDGE_TOLERANCE_PX) return bottomDelta
    return 0
}

/**
 * The scrollable row for `sessionId`, or `null` while it has nowhere to scroll
 * to. Rows of a collapsed project stay mounted but are clipped to zero height,
 * so their box is not a scroll target until the project is open.
 */
export function findScrollableSessionRow(
    container: HTMLElement,
    sessionId: string
): HTMLElement | null {
    for (const marker of container.querySelectorAll<HTMLElement>(SESSION_ROW_MARKER_SELECTOR)) {
        if (marker.dataset.sessionId !== sessionId) continue
        const row = marker.closest<HTMLElement>(SESSION_ROW_SELECTOR)
        if (!row) continue
        if (row.closest('.collapsible-panel:not([data-open])')) continue
        return row
    }
    return null
}

/**
 * Height of the sticky project header that pins to the top of the list while
 * the row's group is on screen. Without that inset a row aligned flush with the
 * container's top edge ends up *behind* the header, which reads as "the list
 * scrolled but my session still is not there".
 */
export function resolveSessionGroupHeaderInset(row: HTMLElement): number {
    const group = row.parentElement?.closest(SESSION_GROUP_SELECTOR)
    const header = group?.querySelector<HTMLElement>(SESSION_GROUP_HEADER_SELECTOR)
    return header ? header.getBoundingClientRect().height : 0
}

/**
 * Brings the selected session row into view whenever the selection changes —
 * row click, deep link, or programmatic navigation — and on mount, so
 * returning to the list does not leave the open session off-screen.
 *
 * Deliberately inert when the row is already fully visible: `scrollTop` is
 * never touched in that case, so this cannot reintroduce the unprompted list
 * jumps that `SessionListScrollAnchor` exists to prevent. Live session updates
 * do not re-run it either; only a new `selectedSessionId` does.
 */
export function useScrollSelectedSessionIntoView(
    containerRef: RefObject<HTMLElement | null>,
    selectedSessionId: string | null | undefined
): void {
    useEffect(() => {
        const container = containerRef.current
        if (!container || !selectedSessionId) return

        let frameId: number | null = null
        // Latched once the row has actually been dealt with — revealed, or seen
        // to be in view already — or once the operator takes over the scroll.
        // A run that simply never finds the row does NOT latch: the row may
        // still be on its way (a freshly created session navigates before its
        // row exists), and the list growing will start a fresh attempt.
        let isDone = false
        let hasScrolled = false
        let previousScrollHeight = -1
        let startedAt = 0

        const cancelFrame = () => {
            if (frameId !== null) cancelAnimationFrame(frameId)
            frameId = null
        }

        const finish = () => {
            isDone = true
            cancelFrame()
        }

        const step = (now: number) => {
            frameId = null
            const viewport = container.getBoundingClientRect()
            // Nothing to measure while the list has no layout (it is still
            // `display: none`, or mid-mount). Not a failure — wait it out.
            if (viewport.height <= 0) return

            // A project animating open grows the list every frame, and clamps
            // `scrollTop` until it is done, so the reveal can need several
            // passes before it lands.
            const scrollHeight = container.scrollHeight
            const listHasSettled = scrollHeight === previousScrollHeight
            previousScrollHeight = scrollHeight

            const row = findScrollableSessionRow(container, selectedSessionId)
            if (row) {
                const delta = resolveSessionScrollDelta(
                    { top: viewport.top + resolveSessionGroupHeaderInset(row), bottom: viewport.bottom },
                    row.getBoundingClientRect()
                )
                if (delta === 0 && (!hasScrolled || listHasSettled)) {
                    // In view — and either the list was never moved at all, or
                    // the reveal has landed and nothing is still shifting.
                    finish()
                    return
                }
                if (delta !== 0) {
                    container.scrollTop += delta
                    hasScrolled = true
                }
            }
            if (now - startedAt >= SCROLL_SELECTED_SESSION_SETTLE_MS) {
                // Out of time for this attempt. If the row was there and we
                // moved the list, that is as good as it gets; if it never
                // showed up, stay unlatched so a later arrival can retry.
                if (hasScrolled) finish()
                else cancelFrame()
                return
            }
            frameId = requestAnimationFrame(step)
        }

        const start = () => {
            if (isDone || frameId !== null) return
            startedAt = performance.now()
            previousScrollHeight = -1
            step(startedAt)
        }

        // Any deliberate scroll input outranks the reveal: wheel and touch, but
        // also a scrollbar drag (pointerdown lands on the scroll container) and
        // the keys that scroll it while a row inside has focus.
        const takeoverEvents = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const
        for (const name of takeoverEvents) {
            container.addEventListener(name, finish, { passive: true })
        }

        // Watch the list's content, not the scroll port: the port keeps its
        // size while rows arrive. A session created through the spawn flow
        // navigates on the next frame but its row only exists once the sessions
        // query has refetched, which is routinely later than one attempt.
        let contentObserver: ResizeObserver | null = null
        const content = container.firstElementChild
        if (content && typeof ResizeObserver !== 'undefined') {
            contentObserver = new ResizeObserver(start)
            contentObserver.observe(content)
        }
        start()

        return () => {
            contentObserver?.disconnect()
            for (const name of takeoverEvents) {
                container.removeEventListener(name, finish)
            }
            finish()
        }
    }, [containerRef, selectedSessionId])
}
