import type { SessionSummary } from '@/types/api'
import { groupSessionsByDirectory } from '@/components/SessionList'
import { basename } from '@/utils/path'

export type ResolvedBoardItemDirectory = {
    directory: string
    machineId: string
}

/**
 * Resolves a to-do item's `repo` (e.g. "heavygee/hapi-demo-board") to a known
 * local working directory, for pre-filling the existing new-session flow
 * (hapi#235/#238 — reuses NewSession's `initialDirectory`/`initialMachineId`,
 * no new picker). This is a crude heuristic, not a real git-remote lookup:
 * HAPI doesn't record a repo↔directory mapping anywhere (no session reports
 * `git remote get-url origin`), so this matches on the final path segment of
 * each known working directory against the repo's name. Good enough for the
 * common "cloned into a directory named after the repo" case; a fork cloned
 * under a different directory name won't match — that's fine, zero matches
 * means the dialog behaves like a completely normal new-session flow.
 *
 * When multiple directories share that basename (e.g. a main checkout plus
 * worktrees, or genuinely unrelated repos that happen to share a name),
 * picks the single best guess rather than asking the user to choose here —
 * `groupSessionsByDirectory`'s own ordering (pinned, then active, then most
 * recently updated) already encodes "where the operator is probably
 * working," and the directory field's existing autocomplete lets them
 * switch if the guess is wrong.
 *
 * Requires a known machine for the match. A directory string alone is
 * ambiguous without it — `NewSession` only trusts `initialMachineId` when
 * it's supplied; leaving it unset makes the form fall back to a last-used
 * or first-available machine that could easily be a *different* host than
 * where this directory actually lives, pairing a real path with the wrong
 * machine. Treating "matched directory, unknown machine" the same as "no
 * match" is the safer call: the operator still gets a fully normal
 * new-session flow (per #235's explicit zero-match behavior) instead of a
 * silently wrong pre-fill.
 *
 * `onlineMachineIds` further restricts matches to machines that are
 * *currently* online (`/api/machines`, which only lists online runners) —
 * without this, a basename match from a historical session whose runner
 * went offline would still return that machine id, and `NewSession` would
 * then silently swap in a different (online) machine while keeping the
 * nonexistent directory, pairing a path from one host with another
 * (hapi#238 Codex review).
 */
export function resolveBoardItemDirectory(
    repo: string | null,
    sessions: SessionSummary[],
    onlineMachineIds: ReadonlySet<string>
): ResolvedBoardItemDirectory | null {
    if (!repo) {
        return null
    }
    const repoName = repo.split('/').pop()?.trim().toLowerCase()
    if (!repoName) {
        return null
    }

    const match = groupSessionsByDirectory(sessions).find(
        group => group.machineId !== null && onlineMachineIds.has(group.machineId) && basename(group.directory).toLowerCase() === repoName
    )
    if (!match || !match.machineId) {
        return null
    }
    return { directory: match.directory, machineId: match.machineId }
}
