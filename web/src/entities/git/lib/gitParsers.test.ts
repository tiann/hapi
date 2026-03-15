import { describe, expect, it } from 'vitest'
import {
    parseStatusSummaryV2,
    parseNumStat,
    createDiffStatsMap,
    getCurrentBranchV2,
    buildGitStatusFiles,
} from './gitParsers'

describe('gitParsers lib', () => {
    describe('parseStatusSummaryV2', () => {
        it('parses branch information', () => {
            const output = `# branch.oid abc123
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1`
            const result = parseStatusSummaryV2(output)
            expect(result.branch.oid).toBe('abc123')
            expect(result.branch.head).toBe('main')
            expect(result.branch.upstream).toBe('origin/main')
            expect(result.branch.ahead).toBe(2)
            expect(result.branch.behind).toBe(1)
        })

        it('parses ordinary file changes', () => {
            const output = '1 M. N... 100644 100644 100644 abc123 def456 file.txt'
            const result = parseStatusSummaryV2(output)
            expect(result.files).toHaveLength(1)
            expect(result.files[0]?.path).toBe('file.txt')
            expect(result.files[0]?.index).toBe('M')
            expect(result.files[0]?.workingDir).toBe('.')
        })

        it('parses renamed files', () => {
            const output = '2 R. N... 100644 100644 100644 abc123 def456 R100 old.txt\tnew.txt'
            const result = parseStatusSummaryV2(output)
            expect(result.files).toHaveLength(1)
            expect(result.files[0]?.path).toBe('new.txt')
            expect(result.files[0]?.from).toBe('old.txt')
            expect(result.files[0]?.index).toBe('R')
        })

        it('parses untracked files', () => {
            const output = '? untracked.txt'
            const result = parseStatusSummaryV2(output)
            expect(result.notAdded).toContain('untracked.txt')
        })

        it('parses ignored files', () => {
            const output = '! ignored.txt'
            const result = parseStatusSummaryV2(output)
            expect(result.ignored).toContain('ignored.txt')
        })

        it('handles empty output', () => {
            const result = parseStatusSummaryV2('')
            expect(result.files).toHaveLength(0)
            expect(result.notAdded).toHaveLength(0)
            expect(result.ignored).toHaveLength(0)
        })
    })

    describe('parseNumStat', () => {
        it('parses file statistics', () => {
            const output = '10\t5\tfile.txt'
            const result = parseNumStat(output)
            expect(result.files).toHaveLength(1)
            expect(result.files[0]?.file).toBe('file.txt')
            expect(result.files[0]?.insertions).toBe(10)
            expect(result.files[0]?.deletions).toBe(5)
            expect(result.files[0]?.changes).toBe(15)
            expect(result.insertions).toBe(10)
            expect(result.deletions).toBe(5)
            expect(result.changes).toBe(15)
            expect(result.changed).toBe(1)
        })

        it('handles binary files', () => {
            const output = '-\t-\tbinary.png'
            const result = parseNumStat(output)
            expect(result.files).toHaveLength(1)
            expect(result.files[0]?.binary).toBe(true)
            expect(result.files[0]?.insertions).toBe(0)
            expect(result.files[0]?.deletions).toBe(0)
        })

        it('parses multiple files', () => {
            const output = `10\t5\tfile1.txt
20\t10\tfile2.txt`
            const result = parseNumStat(output)
            expect(result.files).toHaveLength(2)
            expect(result.insertions).toBe(30)
            expect(result.deletions).toBe(15)
            expect(result.changed).toBe(2)
        })

        it('handles empty output', () => {
            const result = parseNumStat('')
            expect(result.files).toHaveLength(0)
            expect(result.insertions).toBe(0)
            expect(result.deletions).toBe(0)
        })
    })

    describe('createDiffStatsMap', () => {
        it('creates stats map from summary', () => {
            const summary = {
                files: [
                    { file: 'test.txt', insertions: 10, deletions: 5, changes: 15, binary: false },
                ],
                insertions: 10,
                deletions: 5,
                changes: 15,
                changed: 1,
            }
            const map = createDiffStatsMap(summary)
            expect(map['test.txt']).toEqual({ added: 10, removed: 5, binary: false })
        })

        it('handles renamed files', () => {
            const summary = {
                files: [
                    { file: 'old.txt => new.txt', insertions: 10, deletions: 5, changes: 15, binary: false },
                ],
                insertions: 10,
                deletions: 5,
                changes: 15,
                changed: 1,
            }
            const map = createDiffStatsMap(summary)
            expect(map['old.txt => new.txt']).toBeDefined()
        })
    })

    describe('getCurrentBranchV2', () => {
        it('returns branch name', () => {
            const summary = {
                files: [],
                notAdded: [],
                ignored: [],
                branch: { head: 'main' },
            }
            expect(getCurrentBranchV2(summary)).toBe('main')
        })

        it('returns null for detached HEAD', () => {
            const summary = {
                files: [],
                notAdded: [],
                ignored: [],
                branch: { head: '(detached)' },
            }
            expect(getCurrentBranchV2(summary)).toBe(null)
        })

        it('returns null for initial state', () => {
            const summary = {
                files: [],
                notAdded: [],
                ignored: [],
                branch: { head: '(initial)' },
            }
            expect(getCurrentBranchV2(summary)).toBe(null)
        })

        it('returns null when head is undefined', () => {
            const summary = {
                files: [],
                notAdded: [],
                ignored: [],
                branch: {},
            }
            expect(getCurrentBranchV2(summary)).toBe(null)
        })
    })

    describe('buildGitStatusFiles', () => {
        it('builds complete git status', () => {
            const statusOutput = `# branch.head main
1 .M N... 100644 100644 100644 abc123 def456 file.txt`
            const unstagedDiff = '10\t5\tfile.txt'
            const stagedDiff = ''

            const result = buildGitStatusFiles(statusOutput, unstagedDiff, stagedDiff)
            expect(result.branch).toBe('main')
            expect(result.unstagedFiles).toHaveLength(1)
            expect(result.unstagedFiles[0]?.fullPath).toBe('file.txt')
            expect(result.unstagedFiles[0]?.status).toBe('modified')
        })

        it('handles staged files', () => {
            const statusOutput = '1 M. N... 100644 100644 100644 abc123 def456 file.txt'
            const unstagedDiff = ''
            const stagedDiff = '10\t5\tfile.txt'

            const result = buildGitStatusFiles(statusOutput, unstagedDiff, stagedDiff)
            expect(result.stagedFiles).toHaveLength(1)
            expect(result.stagedFiles[0]?.isStaged).toBe(true)
        })

        it('handles untracked files', () => {
            const statusOutput = '? untracked.txt'
            const unstagedDiff = ''
            const stagedDiff = ''

            const result = buildGitStatusFiles(statusOutput, unstagedDiff, stagedDiff)
            expect(result.unstagedFiles).toHaveLength(1)
            expect(result.unstagedFiles[0]?.status).toBe('untracked')
            expect(result.unstagedFiles[0]?.linesAdded).toBe(0)
        })

        it('calculates totals correctly', () => {
            const statusOutput = `1 M. N... 100644 100644 100644 abc123 def456 file1.txt
1 .M N... 100644 100644 100644 abc123 def456 file2.txt`
            const unstagedDiff = '10\t5\tfile2.txt'
            const stagedDiff = '20\t10\tfile1.txt'

            const result = buildGitStatusFiles(statusOutput, unstagedDiff, stagedDiff)
            expect(result.totalUnstaged).toBe(1)
            expect(result.totalStaged).toBe(1)
        })
    })
})
