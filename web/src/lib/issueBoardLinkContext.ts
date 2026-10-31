import { createContext, useContext } from 'react'
import type { ExternalRef } from '@hapi/protocol/types'
import type { BoardItemMatch } from '@/lib/externalRefs'

export type IssueBoardLinkContextValue = {
    getBoardMatchForIssue: (ref: ExternalRef) => BoardItemMatch | null
    onOpenBoardItem: (match: BoardItemMatch) => void
}

/**
 * Bridges the reverse "this session's linked issue is tracked on a board"
 * lookup (owned by `SessionsPage`, where `sessionsMode`/board selection
 * state actually lives) across to `SessionPage`/`SessionChat`/`SessionHeader`
 * — components mounted via `<Outlet/>` inside `SessionsPage`'s own tree, not
 * reachable by plain props (operator follow-up to hapi#238, via Fekko).
 *
 * A Context rather than lifting `sessionsMode` itself into shared/persisted
 * state: that state is deliberately per-tab/ephemeral today ("mode switching
 * never touches the URL", `useBoardSelection`'s cross-tab `storage` sync is a
 * different, narrower concern), and broadening it just to reach across one
 * Outlet boundary would change behavior well beyond what this feature needs.
 */
export const IssueBoardLinkContext = createContext<IssueBoardLinkContextValue | null>(null)

/** Null when Boards isn't configured/owner-only, or outside `SessionsPage`'s tree (e.g. in tests). Callers must treat it as optional. */
export function useIssueBoardLink(): IssueBoardLinkContextValue | null {
    return useContext(IssueBoardLinkContext)
}
