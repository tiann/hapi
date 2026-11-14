import { describe, expect, it } from 'vitest'
import { isBoardItemDetailNavigation, isHistoryPopNavigation, shouldExitBoardsModeForNavigation } from './sessionsBoardsModeSync'

describe('shouldExitBoardsModeForNavigation', () => {
    it('exits To-Do mode on navigation to a session route, even the one already shown by the URL', () => {
        // Regression (hapi#238 Codex review): a toast/sidebar click that
        // re-targets the session the URL already points to (because mode
        // switching never touches the URL) must still surface it — an
        // id-equality check can't see this navigation at all.
        expect(shouldExitBoardsModeForNavigation('/sessions/session-1', 'boards')).toBe(true)
    })

    it('exits To-Do mode on navigation to a different session', () => {
        expect(shouldExitBoardsModeForNavigation('/sessions/session-2', 'boards')).toBe(true)
    })

    it('exits Boards mode for a new-session route too (Codex review)', () => {
        // Regression: this used to be excluded on the theory that composing
        // a new session was never routed through "exit Boards" — true only
        // for the board-spawn flow itself, which already resets both
        // sessionsMode and the selected item explicitly before it ever
        // navigates. Any OTHER way of reaching /sessions/new while Boards
        // mode is active with an item selected (browser Forward/Back being
        // the obvious one) left both untouched, so the right pane kept
        // rendering the stale selected item's detail instead of <Outlet/>
        // — hiding the new-session form entirely on mobile.
        expect(shouldExitBoardsModeForNavigation('/sessions/new', 'boards')).toBe(true)
    })

    it('exits Boards mode for nested session routes too (Codex review)', () => {
        // Regression: the one-segment-only regex missed /sessions/:id/files,
        // /terminal, /file — browser history landing on one of these while
        // Boards mode was active with an item selected left both untouched,
        // so the stale board item detail kept rendering over the outlet
        // instead of the requested session surface.
        expect(shouldExitBoardsModeForNavigation('/sessions/session-1/files', 'boards')).toBe(true)
        expect(shouldExitBoardsModeForNavigation('/sessions/session-1/terminal', 'boards')).toBe(true)
        expect(shouldExitBoardsModeForNavigation('/sessions/session-1/file', 'boards')).toBe(true)
    })

    it('does NOT exit To-Do mode for a non-session route', () => {
        expect(shouldExitBoardsModeForNavigation('/browse', 'boards')).toBe(false)
        expect(shouldExitBoardsModeForNavigation('/sessions', 'boards')).toBe(false)
    })

    it('does nothing while already in Sessions mode', () => {
        expect(shouldExitBoardsModeForNavigation('/sessions/session-1', 'sessions')).toBe(false)
    })
})

describe('isBoardItemDetailNavigation', () => {
    it('is true when selecting a board item for the first time (boardItem only on the destination)', () => {
        // Regression (Codex review, hapi#238): once boardItem became real
        // router search state, selecting an item while Boards overlays an
        // existing /sessions/:id route called navigate({ to: '.' }), whose
        // destination pathname is unchanged — exactly what
        // shouldExitBoardsModeForNavigation treats as session-targeting,
        // kicking straight back to Sessions mode the instant an item was
        // selected.
        expect(isBoardItemDetailNavigation(false, {}, { boardItem: 'item-1' })).toBe(true)
    })

    it('is true when closing a board item (boardItem only on the origin) — the detail pane\'s own Back button or genuine browser/device Back', () => {
        expect(isBoardItemDetailNavigation(false, { boardItem: 'item-1' }, {})).toBe(true)
    })

    it('is true when switching directly between two items\' details', () => {
        expect(isBoardItemDetailNavigation(false, { boardItem: 'item-1' }, { boardItem: 'item-2' })).toBe(true)
    })

    it('is false for a toast/sidebar re-target to the same session with no board item involved on either side', () => {
        // This is shouldExitBoardsModeForNavigation's own established case —
        // a toast click re-targeting the session the URL already points to
        // must still exit Boards mode and surface it, even though the
        // pathname is unchanged, since neither side of this transition has
        // anything to do with a board item at all.
        expect(isBoardItemDetailNavigation(false, {}, {})).toBe(false)
    })

    it('is false whenever the pathname actually changes, even if boardItem is involved', () => {
        expect(isBoardItemDetailNavigation(true, { boardItem: 'item-1' }, {})).toBe(false)
        expect(isBoardItemDetailNavigation(true, {}, { boardItem: 'item-1' })).toBe(false)
    })
})

describe('isHistoryPopNavigation', () => {
    it('is true for a genuine Back — landing on a lower index than any seen so far', () => {
        expect(isHistoryPopNavigation(0, 1)).toBe(true)
    })

    it('is true for a genuine Forward — re-landing on an index already seen (even if it equals the current max)', () => {
        expect(isHistoryPopNavigation(1, 1)).toBe(true)
    })

    it('is false for a fresh push — a brand-new index higher than any seen so far', () => {
        // Regression (Codex review, hapi#238): a toast or in-chat session
        // link targeting the same session Boards is already overlaying with
        // an item selected is event-shape-identical, via plain location
        // diffing, to closing that item via Back — only the history index
        // tells them apart. A fresh navigate() call always stamps a new,
        // higher index, never one already seen.
        expect(isHistoryPopNavigation(2, 1)).toBe(false)
    })
})
