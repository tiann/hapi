// A toast click or an in-chat session citation link targeting a session
// Boards is already overlaying with an item selected is, by pathname and
// `boardItem` search diff alone, indistinguishable from closing that item
// via the detail pane's own Back button — same pathname, `boardItem` only
// on the origin. router.tsx's onBeforeNavigate subscriber used to tell
// these apart via isHistoryPopNavigation's index comparison, on the
// assumption that TanStack Router's `__TSR_index` is only ever reused when
// *replaying* an existing entry. That assumption breaks without a reload:
// the index is computed as `(current location's own index) + 1` at push
// time, so a fresh push made right after a Back reuses whatever index the
// Back-away-from entry used to have — a toast/link click can land on an
// index `isHistoryPopNavigation` has already seen, and gets misread as a
// pop (review finding, broader than the previously-documented reload-only
// gap). TanStack's own internal push-vs-pop signal (HistoryAction) isn't
// reachable through any public API (confirmed by hand), so the fix is an
// explicit signal from the one place that actually knows its own intent —
// the call site — set immediately before `navigate()`. Module-level, not a
// React Context: ToastContainer (App.tsx) and SessionPathAnchor
// (markdown-text.tsx, inside chat messages) are not descendants of
// SessionsPage, where the onBeforeNavigate subscriber and its heuristics
// live, so a Context provider cannot reach them.
let intentFlag = false

/** Call immediately before `navigate()` for a click whose entire point is "show me this session's chat." */
export function markExplicitSessionNavigationIntent(): void {
    intentFlag = true
}

/** Consumed once per onBeforeNavigate event; always resets regardless of the value read. */
export function consumeExplicitSessionNavigationIntent(): boolean {
    const value = intentFlag
    intentFlag = false
    return value
}
