export type WorktreeSpawnParams = {
    sessionType?: 'worktree'
    worktreeName?: string
    worktreeBranch?: string
}

export function normalizeGitBranches(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
        return []
    }

    const seen = new Set<string>()
    const next: string[] = []

    for (const value of raw) {
        if (typeof value !== 'string') {
            continue
        }

        const trimmed = value.trim()
        if (!trimmed || seen.has(trimmed)) {
            continue
        }

        seen.add(trimmed)
        next.push(trimmed)
    }

    return next
}

export function buildWorktreeSpawnParams(
    supportsWorktree: boolean,
    worktreeName: string,
    worktreeBranch: string
): WorktreeSpawnParams {
    if (!supportsWorktree) {
        return {}
    }

    return {
        sessionType: 'worktree',
        worktreeName: worktreeName.trim() || undefined,
        worktreeBranch: worktreeBranch.trim() || undefined
    }
}
