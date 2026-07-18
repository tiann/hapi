import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomId } from './randomId'

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('randomId', () => {
    it('uses crypto.randomUUID when available', () => {
        const randomUUID = vi.fn(() => 'uuid-1')
        vi.stubGlobal('crypto', { randomUUID })

        expect(randomId()).toBe('uuid-1')
        expect(randomUUID).toHaveBeenCalledTimes(1)
    })

    it('falls back without throwing when crypto.randomUUID is unavailable', () => {
        vi.stubGlobal('crypto', {})

        expect(() => randomId()).not.toThrow()
        expect(randomId()).toMatch(/.+/)
        expect(randomId()).not.toBe(randomId())
    })
})
