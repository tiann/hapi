import type { KeyboardEvent, MouseEvent } from 'react'

const NESTED_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, summary, [role="button"], [role="status"]'

type NestedTargetEvent = Pick<MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, 'target' | 'currentTarget'>

/**
 * Returns true when the event originated on (or inside) an interactive
 * descendant such as a tool-card button, retry button, dialog trigger, or the
 * Markdown code-copy button. The metadata toggle handler should bail out so
 * its bubble-level handler does not also flip the metadata footer — relevant
 * for both mouse clicks and keyboard activation (Enter/Space) on those
 * descendants.
 *
 * `Element` (not `HTMLElement`) so that events landing on the `<svg>` or
 * `<path>` descendants of icon-only buttons are still walked back up to the
 * enclosing button via `closest`.
 *
 * `currentTarget` (the toggle wrapper itself) is excluded — the wrapper carries
 * `role="button"` for keyboard accessibility, so without this guard `closest`
 * would always match the wrapper from any inner event and the toggle would
 * never fire.
 */
export function isNestedInteractiveEvent(event: NestedTargetEvent): boolean {
    const target = event.target
    if (!(target instanceof Element)) return false
    const match = target.closest(NESTED_INTERACTIVE_SELECTOR)
    return match !== null && match !== event.currentTarget
}
