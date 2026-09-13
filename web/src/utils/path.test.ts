import { describe, expect, it } from 'vitest'
import { getPathDisplayName } from './path'

describe('getPathDisplayName', () => {
    it('keeps the final two segments for nested POSIX paths', () => {
        expect(getPathDisplayName('/home/user/coding/hapi')).toBe('coding/hapi')
    })

    it('supports Windows path separators', () => {
        expect(getPathDisplayName('C:\\Users\\Ananovo\\Downloads\\Agent\\Hapi')).toBe('Agent/Hapi')
    })

    it('keeps short paths and the fallback group unchanged', () => {
        expect(getPathDisplayName('hapi')).toBe('hapi')
        expect(getPathDisplayName('Other')).toBe('Other')
        expect(getPathDisplayName('')).toBe('')
    })
})
