import { describe, expect, it } from 'vitest'
import { berryModeForPreference } from './types'

const GLM_MODEL = 'newapi/glm-5.3'

describe('berryModeForPreference', () => {
    it('drops the model field entirely for an unset preference', () => {
        // Ordinary turns without a preference must hash identically to a
        // mode-less batch; the launcher's reset branch must never see them.
        expect(berryModeForPreference(undefined)).toEqual({})
        expect('model' in berryModeForPreference(undefined)).toBe(false)
    })

    it('keeps null as the explicit Default reset request', () => {
        expect(berryModeForPreference(null)).toEqual({ model: null })
    })

    it('forwards a concrete model verbatim', () => {
        const GLM = 'newapi/glm-5.3'
        expect(berryModeForPreference(GLM)).toEqual({ model: GLM })
    })

    it('attaches the permission mode only once one is set', () => {
        expect(berryModeForPreference(GLM_MODEL)).toEqual({ model: GLM_MODEL })
        expect(berryModeForPreference(GLM_MODEL, 'yolo')).toEqual({ model: GLM_MODEL, permissionMode: 'yolo' })
        expect(berryModeForPreference(undefined, 'safe-yolo')).toEqual({ permissionMode: 'safe-yolo' })
    })
})
