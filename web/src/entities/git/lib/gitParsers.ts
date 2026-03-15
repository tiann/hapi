import type { GitFileStatus, GitStatusFiles } from '@/types/api'

export type GitFileEntryV2 = {
    path: string
    index: string
    workingDir: string
    from?: string
}

export type GitBranchInfo = {
    oid?: string
    head?: string
    upstream?: string
    ahead?: number
    behind?: number
}

export type GitStatusSummaryV2 = {
    files: GitFileEntryV2[]
    notAdded: string[]
    ignored: string[]
    branch: GitBranchInfo
}

export type DiffFileStat = {
    file: string
    changes: number
    insertions: number
    deletions: number
    binary: boolean
}

export type DiffSummary = {
    files: DiffFileStat[]
    insertions: number
    deletions: number
    changes: number
    changed: number
}

const BRANCH_OID_REGEX = /^# branch\.oid (.+)$/
const BRANCH_HEAD_REGEX = /^# branch\.head (.+)$/
const BRANCH_UPSTREAM_REGEX = /^# branch\.upstream (.+)$/
const BRANCH_AB_REGEX = /^# branch\.ab \+(\d+) -(\d+)$/

const ORDINARY_CHANGE_REGEX = /^1 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (.+)$/
const RENAME_COPY_REGEX = /^2 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([RC])(\d{1,3}) (.+)\t(.+)$/
const UNMERGED_REGEX = /^u (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.+)$/
const UNTRACKED_REGEX = /^\? (.+)$/
const IGNORED_REGEX = /^! (.+)$/

const NUMSTAT_REGEX = /^(\d+|-)\t(\d+|-)\t(.*)$/

export function parseStatusSummaryV2(statusOutput: string): GitStatusSummaryV2 {
    const lines = statusOutput.trim().split('\n').filter((line) => line.length > 0)

    const result: GitStatusSummaryV2 = {
        files: [],
        notAdded: [],
        ignored: [],
        branch: {}
    }

    for (const line of lines) {
        if (line.startsWith('# branch.oid ')) {
            const match = BRANCH_OID_REGEX.exec(line)
            if (match) result.branch.oid = match[1]
            continue
        }
        if (line.startsWith('# branch.head ')) {
            const match = BRANCH_HEAD_REGEX.exec(line)
            if (match) result.branch.head = match[1]
            continue
        }
        if (line.startsWith('# branch.upstream ')) {
            const match = BRANCH_UPSTREAM_REGEX.exec(line)
            if (match) result.branch.upstream = match[1]
            continue
        }
        if (line.startsWith('# branch.ab ')) {
            const match = BRANCH_AB_REGEX.exec(line)
            if (match) {
                result.branch.ahead = parseInt(match[1], 10)
                result.branch.behind = parseInt(match[2], 10)
            }
            continue
        }

        if (line.startsWith('1 ')) {
            const match = ORDINARY_CHANGE_REGEX.exec(line)
            if (match) {
                const entry = parseOrdinaryChange(match)
                if (entry) result.files.push(entry)
            }
            continue
        }

        if (line.startsWith('2 ')) {
            const match = RENAME_COPY_REGEX.exec(line)
            if (match) {
                const entry = parseRenameCopy(match)
                if (entry) result.files.push(entry)
            }
            continue
        }

        if (line.startsWith('u ')) {
            const match = UNMERGED_REGEX.exec(line)
            if (match) {
                const entry = parseUnmerged(match)
                if (entry) result.files.push(entry)
            }
            continue
        }

        if (line.startsWith('? ')) {
            const match = UNTRACKED_REGEX.exec(line)
            if (match) result.notAdded.push(match[1])
            continue
        }

        if (line.startsWith('! ')) {
            const match = IGNORED_REGEX.exec(line)
            if (match) result.ignored.push(match[1])
        }
    }

    return result
}

export function parseNumStat(numStatOutput: string): DiffSummary {
    const lines = numStatOutput.trim().split('\n').filter((line) => line.length > 0)

    const result: DiffSummary = {
        files: [],
        insertions: 0,
        deletions: 0,
        changes: 0,
        changed: 0
    }

    for (const line of lines) {
        const match = NUMSTAT_REGEX.exec(line)
        if (!match) continue
        const insertionsStr = match[1]
        const deletionsStr = match[2]
        const file = match[3]

        const isBinary = insertionsStr === '-' || deletionsStr === '-'
        const insertions = isBinary ? 0 : parseInt(insertionsStr, 10)
        const deletions = isBinary ? 0 : parseInt(deletionsStr, 10)
        const changes = insertions + deletions

        result.files.push({
            file,
            changes,
            insertions,
            deletions,
            binary: isBinary
        })
        result.insertions += insertions
        result.deletions += deletions
        result.changes += changes
        result.changed += 1
    }

    return result
}

export function createDiffStatsMap(summary: DiffSummary): Record<string, { added: number; removed: number; binary: boolean }> {
    const stats: Record<string, { added: number; removed: number; binary: boolean }> = {}

    for (const file of summary.files) {
        const paths = normalizeNumstatPath(file.file)
        const stat = {
            added: file.insertions,
            removed: file.deletions,
            binary: file.binary
        }
        stats[file.file] = stat
        if (paths.newPath && paths.newPath !== file.file) {
            stats[paths.newPath] = stat
        }
        if (paths.oldPath && paths.oldPath !== file.file && paths.oldPath !== paths.newPath) {
            stats[paths.oldPath] = stat
        }
    }

    return stats
}

export function getCurrentBranchV2(summary: GitStatusSummaryV2): string | null {
    const head = summary.branch.head
    if (!head || head === '(detached)' || head === '(initial)') return null
    return head
}

export function buildGitStatusFiles(
    statusOutput: string,
    unstagedDiffOutput: string,
    stagedDiffOutput: string
): GitStatusFiles {
    const statusSummary = parseStatusSummaryV2(statusOutput)
    const branchName = getCurrentBranchV2(statusSummary)

    const unstagedDiff = parseNumStat(unstagedDiffOutput)
    const stagedDiff = parseNumStat(stagedDiffOutput)
    const unstagedStats = createDiffStatsMap(unstagedDiff)
    const stagedStats = createDiffStatsMap(stagedDiff)

    const stagedFiles: GitFileStatus[] = []
    const unstagedFiles: GitFileStatus[] = []

    for (const file of statusSummary.files) {
        const parts = file.path.split('/')
        const fileName = parts[parts.length - 1] || file.path
        const filePath = parts.slice(0, -1).join('/')

        if (file.index !== ' ' && file.index !== '.' && file.index !== '?') {
            const status = getFileStatus(file.index)
            const stats = stagedStats[file.path] ?? { added: 0, removed: 0, binary: false }
            stagedFiles.push({
                fileName,
                filePath,
                fullPath: file.path,
                status,
                isStaged: true,
                linesAdded: stats.added,
                linesRemoved: stats.removed,
                oldPath: file.from
            })
        }

        if (file.workingDir !== ' ' && file.workingDir !== '.') {
            const status = getFileStatus(file.workingDir)
            const stats = unstagedStats[file.path] ?? { added: 0, removed: 0, binary: false }
            unstagedFiles.push({
                fileName,
                filePath,
                fullPath: file.path,
                status,
                isStaged: false,
                linesAdded: stats.added,
                linesRemoved: stats.removed,
                oldPath: file.from
            })
        }
    }

    for (const untrackedPath of statusSummary.notAdded) {
        const cleanPath = untrackedPath.endsWith('/') ? untrackedPath.slice(0, -1) : untrackedPath
        const parts = cleanPath.split('/')
        const fileName = parts[parts.length - 1] || cleanPath
        const filePath = parts.slice(0, -1).join('/')

        if (untrackedPath.endsWith('/')) {
            continue
        }

        unstagedFiles.push({
            fileName,
            filePath,
            fullPath: cleanPath,
            status: 'untracked',
            isStaged: false,
            linesAdded: 0,
            linesRemoved: 0
        })
    }

    return {
        stagedFiles,
        unstagedFiles,
        branch: branchName,
        totalStaged: stagedFiles.length,
        totalUnstaged: unstagedFiles.length
    }
}

function parseOrdinaryChange(matches: string[]): GitFileEntryV2 | null {
    if (!matches[1] || !matches[2] || !matches[9]) return null
    return {
        index: matches[1],
        workingDir: matches[2],
        path: matches[9]
    }
}

function parseRenameCopy(matches: string[]): GitFileEntryV2 | null {
    if (!matches[1] || !matches[2] || !matches[11] || !matches[12]) return null
    return {
        index: matches[1],
        workingDir: matches[2],
        from: matches[11],
        path: matches[12]
    }
}

function parseUnmerged(matches: string[]): GitFileEntryV2 | null {
    if (!matches[1] || !matches[2] || !matches[11]) return null
    return {
        index: matches[1],
        workingDir: matches[2],
        path: matches[11]
    }
}

function getFileStatus(statusChar: string): GitFileStatus['status'] {
    switch (statusChar) {
        case 'M':
            return 'modified'
        case 'A':
            return 'added'
        case 'D':
            return 'deleted'
        case 'R':
        case 'C':
            return 'renamed'
        case '?':
            return 'untracked'
        case 'U':
            return 'conflicted'
        default:
            return 'modified'
    }
}

function normalizeNumstatPath(rawPath: string): { newPath: string; oldPath?: string } {
    const trimmed = rawPath.trim()
    if (trimmed.includes('{') && trimmed.includes('=>') && trimmed.includes('}')) {
        const newPath = trimmed.replace(/\{([^{}]+?)\s*=>\s*([^{}]+?)\}/g, (_, oldPart: string, newPart: string) => newPart.trim())
        const oldPath = trimmed.replace(/\{([^{}]+?)\s*=>\s*([^{}]+?)\}/g, (_, oldPart: string) => oldPart.trim())
        return { newPath, oldPath }
    }

    if (trimmed.includes('=>')) {
        const parts = trimmed.split(/\s*=>\s*/)
        const oldPath = parts[0]?.trim()
        const newPath = parts[parts.length - 1]?.trim()
        if (newPath) {
            return { newPath, oldPath }
        }
    }

    return { newPath: trimmed }
}
