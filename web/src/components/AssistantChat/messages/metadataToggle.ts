import type { MouseEvent } from 'react'

const NESTED_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, summary, [role="button"], [role="status"]'

/**
 * Returns true when the click landed on (or inside) an interactive descendant
 * such as a tool-card button, retry button, dialog trigger, or the Markdown
 * code-copy button. The metadata toggle handler should bail out in that case
 * so its bubble-level click does not also flip the metadata footer.
 *
 * `Element` (not `HTMLElement`) so that clicks landing on the `<svg>` or
 * `<path>` descendants of icon-only buttons are still walked back up to the
 * enclosing button via `closest`.
 *
 * `currentTarget` (the toggle wrapper itself) is excluded — the wrapper carries
 * `role="button"` for keyboard accessibility, so without this guard `closest`
 * would always match the wrapper from any inner click and the toggle would
 * never fire for mouse users.
 */
export function isClickOnNestedControl(event: MouseEvent<HTMLElement>): boolean {
    const target = event.target
    if (!(target instanceof Element)) return false
    const match = target.closest(NESTED_INTERACTIVE_SELECTOR)
    return match !== null && match !== event.currentTarget
}
