import type { MouseEvent } from 'react'

const NESTED_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [role="button"]'

/**
 * Returns true when the click landed on (or inside) an interactive descendant
 * such as a tool-card button, retry button, dialog trigger, or the Markdown
 * code-copy button. The metadata toggle handler should bail out in that case
 * so its bubble-level click does not also flip the metadata footer.
 *
 * `Element` (not `HTMLElement`) so that clicks landing on the `<svg>` or
 * `<path>` descendants of icon-only buttons are still walked back up to the
 * enclosing button via `closest`.
 */
export function isClickOnNestedControl(event: MouseEvent<HTMLElement>): boolean {
    const target = event.target
    return target instanceof Element && target.closest(NESTED_INTERACTIVE_SELECTOR) !== null
}
