import { describe, expect, it } from 'vitest'
import { dshModeForPreference } from './types'

describe('dshModeForPreference', () => {
    it('drops the model field entirely for an unset preference', () => {
        // Ordinary turns without a preference must hash identically to a
        // mode-less batch: an explicit { model: undefined } would survive
        // structural comparison and collide with nothing, but the point is
        // that the launcher's reset branch must never see these turns.
        expect(dshModeForPreference(undefined)).toEqual({})
        expect('model' in dshModeForPreference(undefined)).toBe(false)
    })

    it('keeps null as the explicit Default reset request', () => {
        expect(dshModeForPreference(null)).toEqual({ model: null })
    })

    it('forwards a concrete model verbatim', () => {
        const PRO = '["deepseek-official","deepseek-v4-pro"]'
        expect(dshModeForPreference(PRO)).toEqual({ model: PRO })
    })
})
