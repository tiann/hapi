/**
 * Session-list toolbar keep ranks (tiann/hapi#2039 / #2040).
 *
 * Lower `keep` stays on the row longer. Higher `keep` moves into More first.
 * Rank is survival, not paint order. Search is not a slot: it never sheds.
 *
 * Upstream controls:
 *   4 New
 *   5 Session filter (unread lens)
 *   6 Settings
 *   7 Mark all read (#1773 bulk hygiene — reachable, not a neighbor of New)
 *   8 Browse
 * Machine chips / the mobile machine menu stay outside this ladder.
 * Fork-only Kitchen, Overseer, and agent-import use the same `keep` scale
 * when a soup layer passes them as extras (3 / 9 / 10).
 */

export type ToolbarShedSlot = {
    id: string
    /** Higher sheds first. */
    keep: number
    widthPx: number
}

export const TOOLBAR_ICON_PX = 40
export const TOOLBAR_MORE_PX = 40
export const TOOLBAR_GAP_PX = 4

/**
 * Horizontal budget left for action slots after search chrome and row padding.
 *
 * Prefer measuring the actions flex box and passing that width directly.
 * This fallback is for first paint / tests that stub the full header row.
 * The collapsed query chip is `max-w-[9rem]` + a 40px clear — not 200px.
 * Reserving 200 left a Quest-width desert of empty space after More (#2039).
 */
/**
 * Pixels from the actions box's left edge to the row's content-box right edge.
 * This is the space the icons may fill. A content-sized flex item and a
 * guessed search reserve both lie; the row edge does not.
 */
export function toolbarGutterPx(actionsLeft: number, rowRight: number, rowPaddingRight: number): number {
    if (!(rowRight > actionsLeft)) return 0
    return Math.max(0, rowRight - rowPaddingRight - actionsLeft)
}

export function toolbarActionBudget(headerRowWidth: number, hasQuery: boolean): number {
    if (headerRowWidth <= 0) {
        // Unmeasured must stay finite. Infinity kept every shrink-0 icon inline
        // on first paint, the sidebar min-content grew around them, and the
        // overflow menu never appeared on desktop (#2039 / #2040).
        // Empty: ~Quest actions gutter. Query: daily controls, not [chip][⋯].
        return hasQuery ? 220 : 280
    }
    const searchReserve = hasQuery ? 152 : 56
    const rowPadding = 16
    return Math.max(0, headerRowWidth - searchReserve - rowPadding)
}

export type ToolbarShedMetrics = {
    /** Rendered More button width. Defaults to TOOLBAR_MORE_PX. */
    morePx?: number
    /** Rendered column gap. Defaults to TOOLBAR_GAP_PX. */
    gapPx?: number
}

function clusterWidth(
    slots: readonly ToolbarShedSlot[],
    includeMore: boolean,
    metrics: ToolbarShedMetrics
): number {
    const morePx = metrics.morePx ?? TOOLBAR_MORE_PX
    const gapPx = metrics.gapPx ?? TOOLBAR_GAP_PX
    const itemCount = slots.length + (includeMore ? 1 : 0)
    if (itemCount === 0) return 0
    const icons = slots.reduce((sum, slot) => sum + slot.widthPx, 0) + (includeMore ? morePx : 0)
    return icons + gapPx * (itemCount - 1)
}

/**
 * Drop the highest `keep` until the cluster fits. Paint order of survivors
 * matches input order. `metrics` must be the rendered More width and gap
 * (font scale), not the 16px constants.
 */
export function shedToolbarSlots(
    slots: readonly ToolbarShedSlot[],
    budgetPx: number,
    metrics: ToolbarShedMetrics = {}
): { visibleIds: string[]; overflowIds: string[] } {
    const overflow: ToolbarShedSlot[] = []
    let visible = [...slots]
    const gapPx = metrics.gapPx ?? TOOLBAR_GAP_PX
    // Tolerate one column-gap. Otherwise a hole the size of the next icon
    // (short by only the gap) stays empty, which reads as wasted space.
    while (visible.length > 0 && clusterWidth(visible, overflow.length > 0, metrics) - gapPx > budgetPx) {
        let worstIndex = 0
        for (let index = 1; index < visible.length; index += 1) {
            const candidate = visible[index]
            const worst = visible[worstIndex]
            if (!candidate || !worst) continue
            if (candidate.keep > worst.keep) worstIndex = index
        }
        const [removed] = visible.splice(worstIndex, 1)
        if (removed) overflow.push(removed)
    }
    const order = new Map(slots.map((slot, index) => [slot.id, index]))
    const byPaint = (a: ToolbarShedSlot, b: ToolbarShedSlot) =>
        (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
    visible.sort(byPaint)
    overflow.sort(byPaint)
    return {
        visibleIds: visible.map((slot) => slot.id),
        overflowIds: overflow.map((slot) => slot.id)
    }
}
