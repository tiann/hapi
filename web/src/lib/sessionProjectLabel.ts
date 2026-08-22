export type SessionProjectMetadata = {
    path?: string | null
    worktree?: {
        basePath?: string | null
    } | null
}

/** Use the repository path for worktrees and the session path otherwise. */
export function getSessionProjectPath(metadata: SessionProjectMetadata | null | undefined): string | null {
    if (metadata?.worktree) {
        return metadata.worktree.basePath?.trim() || null
    }
    return metadata?.path?.trim() || null
}

/** Match the compact project labels used by the session sidebar. */
export function getSessionProjectLabel(directory: string): string {
    if (directory === 'Other') return directory
    const parts = directory.split(/[\\/]+/).filter(Boolean)
    if (parts.length === 0) return directory
    if (parts.length === 1) return parts[0]
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}
