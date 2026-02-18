import { describe, expect, it } from 'vitest'
import { buildWorktreeSpawnParams, normalizeGitBranches } from './worktreeSupport'

describe('worktreeSupport helpers', () => {
    it('normalizes branch list to trimmed unique values', () => {
        const normalized = normalizeGitBranches([
            ' main ',
            'feature/foo',
            'main',
            '',
            123,
            null,
            'feature/foo '
        ])

        expect(normalized).toEqual(['main', 'feature/foo'])
    })

    it('returns empty params when worktree is not supported', () => {
        expect(buildWorktreeSpawnParams(false, 'name', 'branch')).toEqual({})
    })

    it('builds worktree spawn params when supported', () => {
        expect(buildWorktreeSpawnParams(true, '  feature-1  ', ' main ')).toEqual({
            sessionType: 'worktree',
            worktreeName: 'feature-1',
            worktreeBranch: 'main'
        })
    })
})
