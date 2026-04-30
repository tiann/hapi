import type { SessionSummary } from '@/types/api'

function normalizePath(path: string): string {
    return path.replace(/\/+$/, '') || '/'
}

function isSameOrChildPath(candidate: string | null | undefined, projectPath: string): boolean {
    if (!candidate) return false
    const normalizedCandidate = normalizePath(candidate)
    const normalizedProject = normalizePath(projectPath)
    return normalizedCandidate === normalizedProject || normalizedCandidate.startsWith(`${normalizedProject}/`)
}

function getWorktreeBasePath(session: SessionSummary): string | null {
    const worktree = session.metadata?.worktree
    if (!worktree || typeof worktree !== 'object') return null
    const basePath = (worktree as { basePath?: unknown }).basePath
    return typeof basePath === 'string' ? basePath : null
}

export function sessionBelongsToEditorProject(
    session: SessionSummary,
    machineId: string,
    projectPath: string
): boolean {
    if (session.metadata?.machineId !== machineId) {
        return false
    }
    return isSameOrChildPath(session.metadata?.path, projectPath)
        || isSameOrChildPath(getWorktreeBasePath(session), projectPath)
}

export function filterSessionsForEditorProject(
    sessions: SessionSummary[],
    machineId: string,
    projectPath: string
): SessionSummary[] {
    return sessions
        .filter((session) => sessionBelongsToEditorProject(session, machineId, projectPath))
        .sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt)
}
