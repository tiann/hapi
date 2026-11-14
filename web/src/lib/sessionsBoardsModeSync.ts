import type { SessionsMode } from '@/components/SessionsModeSwitch'

// Matches /sessions/:id and every nested descendant (/files, /terminal,
// /file, ...) — not just the bare detail route (Codex review, hapi#238: the
// one-segment-only version missed browser history landing on a nested route
// like /sessions/A/files while Boards mode was active, leaving the stale
// board item detail rendered over the outlet instead of exiting Boards mode).
const SESSION_ROUTE = /^\/sessions\/([^/]+)(\/.*)?$/

/**
 * Decides whether an actual router navigation (not a mode-switch click)
 * should exit To-Do mode back to Sessions.
 *
 * Driven by the navigation event itself (the router's `onBeforeNavigate`,
 * which fires for every `navigate()` call regardless of whether the
 * resulting location differs from the current one) rather than by comparing
 * before/after selected-session ids. That distinction matters: switching to
 * To-Do mode never touches the URL, so the common case of opening a chat and
 * then clicking To-Do leaves the route's session id unchanged — an
 * id-equality check alone can't tell that apart from a toast/sidebar click
 * that re-targets the *same* session while already in To-Do mode (which
 * must still surface that session, even though nothing about the id
 * changes). Reacting to the navigation event itself handles both: a mode
 * switch never calls `navigate()` at all, so it's never seen here, while any
 * session-targeting `navigate()` call is (hapi#238 Codex review — two prior
 * passes on the id-equality version: the first reset on "a session is
 * selected" alone and broke opening To-Do from a selected-session route; the
 * second case still couldn't distinguish "navigated to session A" from
 * "already showing session A, navigated to session A again").
 *
 * `/sessions/new` is NOT excluded (Codex review, hapi#238): it used to be,
 * on the theory that composing a new session was never routed through
 * "exit Boards" — true for the board-spawn flow itself, which already
 * resets both `sessionsMode` and the selected item explicitly before it
 * ever calls `navigate()` (`handleSpawnFromBoardItem`), so it never relied
 * on this function for that. But any OTHER way of reaching `/sessions/new`
 * while Boards mode is active with an item selected — browser Forward/Back
 * being the obvious one — left both pieces of state untouched, and the
 * right pane keeps rendering the stale selected item's detail instead of
 * `<Outlet/>` (hiding the new-session form entirely on mobile, where only
 * one pane shows at a time). Exiting Boards mode for `/sessions/new` too,
 * same as any other session-targeting route, fixes that without changing
 * anything about the board-spawn flow's own already-explicit reset.
 */
export function shouldExitBoardsModeForNavigation(pathname: string, sessionsMode: SessionsMode): boolean {
    if (sessionsMode !== 'boards') return false
    return SESSION_ROUTE.test(pathname)
}

/**
 * Whether a navigation is purely a `boardItem` search-param transition —
 * selecting/closing/switching a board item's detail view while Boards mode
 * overlays an existing session route — and so must be exempted from
 * `shouldExitBoardsModeForNavigation` above (Codex review, hapi#238: once
 * `boardItem` became real router search state, selecting an item while
 * Boards was layered over `/sessions/:id` called `navigate({ to: '.' })`,
 * whose destination pathname is unchanged — exactly what
 * `shouldExitBoardsModeForNavigation` treats as session-targeting, so it
 * immediately kicked back out to Sessions mode the instant an item was
 * selected).
 *
 * `pathChanged` must be false — a *genuine* navigation to the same pathname
 * (the toast/sidebar-re-target case the function above exists for) must
 * still exit Boards mode, and critically that case has `boardItem` absent
 * from search on *both* sides, so checking "does either side have
 * `boardItem` set" alone correctly leaves it unexempted. Checking either
 * side (not just one) is what makes this symmetric across every direction
 * the transition can run: selecting an item for the first time only sets it
 * on `to`; the detail pane's own Back button or genuine browser/device Back
 * popping through that same history entry only has it on `from`; switching
 * directly between two items' details has it on both.
 *
 * IMPORTANT (Codex review, hapi#238, third finding on this path): this
 * predicate alone is NOT enough to decide the exemption — it must only be
 * consulted for navigations that `isHistoryPopNavigation` identifies as
 * replaying existing browser history (device/browser Back or Forward). A
 * toast or in-chat session link that happens to target the *same* session
 * Boards is already overlaying with an item selected is event-shape-identical
 * to closing that item via Back (same pathname, `boardItem` only on the
 * origin) — but it's a *fresh* `navigate()` push, not a history replay, and
 * must still exit Boards mode to surface that session's chat. Pure
 * before/after location-diffing can't tell these two apart; only the
 * underlying history action (push vs. pop) can. See `isHistoryPopNavigation`.
 */
export function isBoardItemDetailNavigation(
    pathChanged: boolean,
    fromSearch: { boardItem?: unknown },
    toSearch: { boardItem?: unknown }
): boolean {
    if (pathChanged) return false
    return typeof fromSearch.boardItem === 'string' || typeof toSearch.boardItem === 'string'
}

/**
 * Whether a navigation is replaying an already-existing browser history entry
 * (device/browser Back or Forward) rather than pushing a brand-new one (a
 * fresh `navigate()` call from app code — selecting a board item, a toast
 * click, an in-chat session link, ...).
 *
 * CORRECTION (review finding, hapi#238 — this function's index assumption was
 * wrong, not just incomplete): `__TSR_index` is NOT a global monotonically
 * increasing counter. TanStack Router computes a fresh push's index as
 * `(current location's own stamped index) + 1` at push time (confirmed by
 * reading `@tanstack/router-core`'s source, not just inferred from
 * behavior) — so after a Back navigation, the *next* fresh push reuses
 * whatever index the entry you backed away from used to have. Concretely:
 * select X (index N+1), select Y (N+2), Back to X (lands back on N+1), then
 * a brand-new push (a toast click, an in-chat link) computes N+1+1 = N+2 —
 * exactly Y's old index, which `maxIndexSeen` has already recorded as seen.
 * Comparing against the high-water mark alone therefore misreads that fresh
 * push as a pop, with no reload required (broader than this function
 * previously documented as an accepted, reload-only gap).
 *
 * Because no index-only heuristic can resolve this — and TanStack's own
 * internal push-vs-pop signal (`HistoryAction`, recorded in
 * `@tanstack/router-core`'s `locationHistoryActions` WeakMap) isn't reachable
 * through any public API (confirmed: a subpath import throws at resolution)
 * and its public events fire *after* `onBeforeNavigate` has already run — the
 * real fix is `explicitSessionNavigationIntent.ts`: the handful of call sites
 * that know their own intent (ToastContainer, SessionPathAnchor in
 * markdown-text.tsx) mark it explicitly right before calling `navigate()`,
 * and `router.tsx`'s `onBeforeNavigate` subscriber honors that signal over
 * this function's result. This function remains the fallback for any
 * session-targeting navigation that doesn't (and can't practically) set that
 * signal — callers must still track `maxIndexSeen` themselves (it is not
 * global router state), updating it to `Math.max(maxIndexSeen, toIndex)`
 * after each call regardless of the result, seeded from the current entry's
 * own index at mount (not a hardcoded 0) so a page reloaded mid-session
 * already knows its real starting position.
 */
export function isHistoryPopNavigation(toIndex: number, maxIndexSeen: number): boolean {
    return toIndex <= maxIndexSeen
}
