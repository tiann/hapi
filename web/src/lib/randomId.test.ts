import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomId } from './randomId'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('randomId', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('uses crypto.randomUUID when available (secure context)', () => {
        const randomUUID = vi.fn(() => '00000000-0000-4000-8000-000000000000')
        vi.stubGlobal('crypto', { randomUUID, getRandomValues: vi.fn() })

        const id = randomId()

        expect(randomUUID).toHaveBeenCalledOnce()
        expect(id).toBe('00000000-0000-4000-8000-000000000000')
    })

    it('falls back to getRandomValues when randomUUID is missing (non-secure context)', () => {
        const getRandomValues = vi.fn((bytes: Uint8Array) => {
            for (let i = 0; i < bytes.length; i++) bytes[i] = i
            return bytes
        })
        vi.stubGlobal('crypto', { getRandomValues })

        const id = randomId()

        expect(getRandomValues).toHaveBeenCalledOnce()
        expect(id).toMatch(UUID_V4)
        // Version 4 bit: byte[6] should be 0x4_ after masking (input 0x06 → 0x46)
        expect(id.charAt(14)).toBe('4')
        // Variant bit: byte[8] high two bits should be 10 (input 0x08 → 0x88)
        expect('89ab'.includes(id.charAt(19).toLowerCase())).toBe(true)
    })

    it('produces unique ids across multiple getRandomValues calls', () => {
        let counter = 0
        const getRandomValues = vi.fn((bytes: Uint8Array) => {
            for (let i = 0; i < bytes.length; i++) bytes[i] = (counter + i) & 0xff
            counter += bytes.length
            return bytes
        })
        vi.stubGlobal('crypto', { getRandomValues })

        const ids = new Set([randomId(), randomId(), randomId()])
        expect(ids.size).toBe(3)
        for (const id of ids) expect(id).toMatch(UUID_V4)
    })

    it('falls back to a Date/Math.random string when crypto is unavailable', () => {
        vi.stubGlobal('crypto', undefined)

        const id = randomId()

        expect(typeof id).toBe('string')
        expect(id.length).toBeGreaterThan(0)
        // Not UUID v4 format; just needs to be non-empty and unique enough
        expect(id).not.toMatch(UUID_V4)
    })
})
