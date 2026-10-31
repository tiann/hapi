import { getPathDisplayName } from '@/utils/path'

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
    return getPathDisplayName(directory)
}
