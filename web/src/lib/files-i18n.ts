type Translate = (key: string, params?: Record<string, string | number>) => string

function normalizeDetail(detail: string | null | undefined): string | null {
    if (typeof detail !== 'string') return null
    const trimmed = detail.trim()
    return trimmed.length > 0 ? trimmed : null
}

function stripPrefix(value: string, prefix: string): string | null {
    if (!value.startsWith(prefix)) return null
    return normalizeDetail(value.slice(prefix.length))
}

function formatGitStatusErrorSegment(segment: string, t: Translate): string {
    const unstagedDetail = stripPrefix(segment, 'Unstaged diff unavailable: ')
    if (unstagedDetail) {
        return t('files.changes.error.unstagedDiffUnavailableWithDetail', { error: unstagedDetail })
    }

    const stagedDetail = stripPrefix(segment, 'Staged diff unavailable: ')
    if (stagedDetail) {
        return t('files.changes.error.stagedDiffUnavailableWithDetail', { error: stagedDetail })
    }

    return t('files.changes.error.gitStatusUnavailableWithDetail', { error: segment })
}

export function getProjectRootLabel(path: string | null | undefined, t: Translate): string {
    return normalizeDetail(path) ?? t('files.projectRoot')
}

export function getDetachedBranchLabel(branch: string | null | undefined, t: Translate): string {
    const value = normalizeDetail(branch)
    if (!value || value === 'detached') {
        return t('files.branch.detached')
    }
    return value
}

export function formatFileSearchError(error: string | null | undefined, t: Translate): string {
    const detail = normalizeDetail(error)
    if (!detail || detail === 'Failed to search files' || detail === 'Session unavailable') {
        return t('files.search.error.failed')
    }
    return t('files.search.error.failedWithDetail', { error: detail })
}

export function formatDirectoryError(error: string | null | undefined, t: Translate): string {
    const detail = normalizeDetail(error)
    if (!detail || detail === 'Failed to list directory' || detail === 'Session unavailable') {
        return t('files.directories.error.listFailed')
    }
    return t('files.directories.error.listFailedWithDetail', { error: detail })
}

export function formatGitStatusError(error: string | null | undefined, t: Translate): string {
    const detail = normalizeDetail(error)
    if (!detail || detail === 'Git status unavailable' || detail === 'Session unavailable') {
        return t('files.changes.error.gitStatusUnavailable')
    }

    const segments = detail
        .split(/(?=Unstaged diff unavailable: |Staged diff unavailable: )/)
        .map((segment) => normalizeDetail(segment))
        .filter((segment): segment is string => Boolean(segment))

    if (segments.length > 1) {
        return segments
            .map((segment) => formatGitStatusErrorSegment(segment, t))
            .join(' ')
    }

    return formatGitStatusErrorSegment(detail, t)
}

export function formatReadFileError(error: string | null | undefined, t: Translate): string {
    const detail = normalizeDetail(error)
    if (!detail || detail === 'Failed to read file' || detail === 'Missing session or path' || detail === 'Session unavailable') {
        return t('file.error.readFailed')
    }
    return t('file.error.readFailedWithDetail', { error: detail })
}

export function formatDiffError(error: string | null | undefined, t: Translate): string {
    const detail = normalizeDetail(error)
    if (!detail || detail === 'Failed to load diff' || detail === 'Missing session or path' || detail === 'Session unavailable') {
        return t('file.error.diffUnavailable')
    }
    return t('file.error.diffUnavailableWithDetail', { error: detail })
}
