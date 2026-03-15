export type GitCommandResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    error?: string
}

export type GitFileStatus = {
    fileName: string
    filePath: string
    fullPath: string
    status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
    isStaged: boolean
    linesAdded: number
    linesRemoved: number
    oldPath?: string
}

export type GitStatusFiles = {
    branch: string | null
    stagedFiles: GitFileStatus[]
    unstagedFiles: GitFileStatus[]
    totalStaged: number
    totalUnstaged: number
}
