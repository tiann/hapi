import type { SessionSummary } from '@/types/api'

/** Short worktree name for session list / mention tooltips. */
export function getWorktreeSessionLabel(session: SessionSummary): string | null {
    const worktree = session.metadata?.worktree
    if (!worktree) {
        return null
    }

    const name = worktree.name.trim()
    if (name) {
        return name
    }

    const path = (worktree.worktreePath ?? session.metadata?.path ?? '').replace(/[\\/]+$/, '')
    const parts = path.split(/[\\/]+/).filter(Boolean)
    return parts.at(-1) ?? null
}
