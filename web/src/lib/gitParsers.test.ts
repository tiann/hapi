import { describe, expect, it } from 'vitest'
import {
    buildGitStatusFiles,
    createDiffStatsMap,
    getCurrentBranchV2,
    parseNumStat,
    parseStatusSummaryV2,
} from './gitParsers'

describe('gitParsers', () => {
    describe('parseStatusSummaryV2', () => {
        it('parses branch headers and all supported porcelain entry types', () => {
            const statusOutput = [
                '# branch.oid abcdef1234567890',
                '# branch.head feature/parser-tests',
                '# branch.upstream origin/feature/parser-tests',
                '# branch.ab +2 -1',
                '1 MM N... 100644 100644 100644 1111111 2222222 src/changed.ts',
                '2 R. N... 100644 100644 100644 3333333 4444444 R100 src/old-name.ts\tsrc/new-name.ts',
                'u UU N... 100644 100644 100644 100644 5555555 6666666 7777777 conflicted.ts',
                '? new-file.ts',
                '! node_modules/',
            ].join('\n')

            const summary = parseStatusSummaryV2(statusOutput)

            expect(summary.branch).toEqual({
                oid: 'abcdef1234567890',
                head: 'feature/parser-tests',
                upstream: 'origin/feature/parser-tests',
                ahead: 2,
                behind: 1,
            })
            expect(summary.files).toEqual([
                {
                    index: 'M',
                    workingDir: 'M',
                    path: 'src/changed.ts',
                },
                {
                    index: 'R',
                    workingDir: '.',
                    from: 'src/old-name.ts',
                    path: 'src/new-name.ts',
                },
                {
                    index: 'U',
                    workingDir: 'U',
                    path: 'conflicted.ts',
                },
            ])
            expect(summary.notAdded).toEqual(['new-file.ts'])
            expect(summary.ignored).toEqual(['node_modules/'])
        })
    })

    describe('parseNumStat', () => {
        it('parses text and binary entries and accumulates totals', () => {
            const output = [
                '12\t3\tsrc/app.ts',
                '-\t-\tassets/logo.png',
                '5\t0\tsrc/new.ts',
            ].join('\n')

            const summary = parseNumStat(output)

            expect(summary.files).toEqual([
                {
                    file: 'src/app.ts',
                    changes: 15,
                    insertions: 12,
                    deletions: 3,
                    binary: false,
                },
                {
                    file: 'assets/logo.png',
                    changes: 0,
                    insertions: 0,
                    deletions: 0,
                    binary: true,
                },
                {
                    file: 'src/new.ts',
                    changes: 5,
                    insertions: 5,
                    deletions: 0,
                    binary: false,
                },
            ])
            expect(summary.insertions).toBe(17)
            expect(summary.deletions).toBe(3)
            expect(summary.changes).toBe(20)
            expect(summary.changed).toBe(3)
        })
    })

    describe('createDiffStatsMap', () => {
        it('normalizes rename paths and maps both old/new aliases', () => {
            const summary = parseNumStat([
                '4\t1\tpackages/{core => web}/index.ts',
                '3\t2\told/path.ts => new/path.ts',
            ].join('\n'))

            const stats = createDiffStatsMap(summary)

            expect(stats['packages/{core => web}/index.ts']).toEqual({ added: 4, removed: 1, binary: false })
            expect(stats['packages/core/index.ts']).toEqual({ added: 4, removed: 1, binary: false })
            expect(stats['packages/web/index.ts']).toEqual({ added: 4, removed: 1, binary: false })

            expect(stats['old/path.ts => new/path.ts']).toEqual({ added: 3, removed: 2, binary: false })
            expect(stats['old/path.ts']).toEqual({ added: 3, removed: 2, binary: false })
            expect(stats['new/path.ts']).toEqual({ added: 3, removed: 2, binary: false })
        })
    })

    describe('getCurrentBranchV2', () => {
        it('returns null for detached or initial HEAD states', () => {
            expect(getCurrentBranchV2({ files: [], notAdded: [], ignored: [], branch: { head: '(detached)' } })).toBeNull()
            expect(getCurrentBranchV2({ files: [], notAdded: [], ignored: [], branch: { head: '(initial)' } })).toBeNull()
        })
    })

    describe('buildGitStatusFiles', () => {
        it('builds staged and unstaged entries and skips untracked directories', () => {
            const statusOutput = [
                '# branch.oid 1234567890abcdef',
                '# branch.head main',
                '1 MM N... 100644 100644 100644 1111111 2222222 src/app.ts',
                '1 A. N... 100644 100644 100644 1111111 2222222 src/new.ts',
                '1 .D N... 100644 100644 100644 1111111 2222222 src/old.ts',
                '? notes.txt',
                '? generated/',
            ].join('\n')

            const unstagedDiff = [
                '2\t4\tsrc/app.ts',
                '0\t7\tsrc/old.ts',
            ].join('\n')

            const stagedDiff = [
                '3\t1\tsrc/app.ts',
                '10\t0\tsrc/new.ts',
            ].join('\n')

            const files = buildGitStatusFiles(statusOutput, unstagedDiff, stagedDiff)

            expect(files.branch).toBe('main')
            expect(files.stagedFiles).toEqual([
                {
                    fileName: 'app.ts',
                    filePath: 'src',
                    fullPath: 'src/app.ts',
                    status: 'modified',
                    isStaged: true,
                    linesAdded: 3,
                    linesRemoved: 1,
                    oldPath: undefined,
                },
                {
                    fileName: 'new.ts',
                    filePath: 'src',
                    fullPath: 'src/new.ts',
                    status: 'added',
                    isStaged: true,
                    linesAdded: 10,
                    linesRemoved: 0,
                    oldPath: undefined,
                },
            ])
            expect(files.unstagedFiles).toEqual([
                {
                    fileName: 'app.ts',
                    filePath: 'src',
                    fullPath: 'src/app.ts',
                    status: 'modified',
                    isStaged: false,
                    linesAdded: 2,
                    linesRemoved: 4,
                    oldPath: undefined,
                },
                {
                    fileName: 'old.ts',
                    filePath: 'src',
                    fullPath: 'src/old.ts',
                    status: 'deleted',
                    isStaged: false,
                    linesAdded: 0,
                    linesRemoved: 7,
                    oldPath: undefined,
                },
                {
                    fileName: 'notes.txt',
                    filePath: '',
                    fullPath: 'notes.txt',
                    status: 'untracked',
                    isStaged: false,
                    linesAdded: 0,
                    linesRemoved: 0,
                },
            ])
            expect(files.totalStaged).toBe(2)
            expect(files.totalUnstaged).toBe(3)
        })
    })
})
