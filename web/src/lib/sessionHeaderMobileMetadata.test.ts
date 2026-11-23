import { describe, expect, it } from 'vitest'
import { selectMobileSessionHeaderSecondary } from './sessionHeaderMobileMetadata'

describe('selectMobileSessionHeaderSecondary', () => {
    it('prioritizes the project label when it is available', () => {
        expect(selectMobileSessionHeaderSecondary({ project: true, machine: true })).toBe('project')
    })

    it('follows the upstream-first display order', () => {
        expect(selectMobileSessionHeaderSecondary({ machine: true, model: true, updatedAt: true })).toBe('machine')
        expect(selectMobileSessionHeaderSecondary({ model: true, updatedAt: true, worktree: true })).toBe('model')
    })

    it('uses the next enabled and available detail when the model is absent', () => {
        expect(selectMobileSessionHeaderSecondary({ machine: true, lastActive: true, updatedAt: true })).toBe('machine')
        expect(selectMobileSessionHeaderSecondary({ lastActive: true, updatedAt: true })).toBe('lastActive')
        expect(selectMobileSessionHeaderSecondary({ fastMode: true, updatedAt: true, createdAt: true, worktree: true })).toBe('fastMode')
        expect(selectMobileSessionHeaderSecondary({ updatedAt: true, createdAt: true, worktree: true })).toBe('createdAt')
        expect(selectMobileSessionHeaderSecondary({ worktree: true, fastMode: true })).toBe('fastMode')
    })

    it('returns no secondary detail when none are available', () => {
        expect(selectMobileSessionHeaderSecondary({})).toBeNull()
    })
})
