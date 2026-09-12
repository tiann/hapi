import { describe, expect, it } from 'vitest'
import { getMobileSessionHeaderMetadata, selectMobileSessionHeaderSecondary } from './sessionHeaderMobileMetadata'

describe('selectMobileSessionHeaderSecondary', () => {
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

    it('returns every available detail in the mobile display order', () => {
        expect(getMobileSessionHeaderMetadata({
            machine: true,
            lastActive: true,
            model: true,
            reasoning: true,
            fastMode: true,
            createdAt: true,
            updatedAt: true,
            worktree: true,
        })).toEqual([
            'machine',
            'lastActive',
            'model',
            'reasoning',
            'fastMode',
            'createdAt',
            'updatedAt',
            'worktree',
        ])
    })
})
