import { describe, expect, it } from 'vitest'
import { getSessionProjectLabel, getSessionProjectPath } from './sessionProjectLabel'

describe('session project labels', () => {
    it('uses the repository path for worktree sessions', () => {
        expect(getSessionProjectPath({
            path: '/work/hapi-worktrees/fix-resume',
            worktree: { basePath: '/work/hapi' },
        })).toBe('/work/hapi')
        expect(getSessionProjectLabel('/work/hapi')).toBe('work/hapi')
    })

    it('formats nested POSIX and Windows paths like the sidebar', () => {
        expect(getSessionProjectLabel('/home/user/coding/hapi')).toBe('coding/hapi')
        expect(getSessionProjectLabel('C:\\work\\hapi')).toBe('work/hapi')
        expect(getSessionProjectLabel('hapi')).toBe('hapi')
    })

    it('falls back to the session path and hides blank paths', () => {
        expect(getSessionProjectPath({ path: '/repo' })).toBe('/repo')
        expect(getSessionProjectPath({ path: '   ' })).toBeNull()
        expect(getSessionProjectPath(null)).toBeNull()
    })

    it('does not treat a worktree with no base path as a simple session', () => {
        expect(getSessionProjectPath({
            path: '/work/hapi-worktrees/fix-resume',
            worktree: { basePath: '   ' },
        })).toBeNull()
    })
})
