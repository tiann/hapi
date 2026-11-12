import { describe, expect, it } from 'vitest'
import { hermesModeForPreference } from './types'

const GLM_MODEL = 'newapi:glm-5.3'

describe('hermesModeForPreference', () => {
    it('drops the model field entirely for an unset preference', () => {
        // Ordinary turns without a preference must hash identically to a
        // mode-less batch; the launcher's reset branch must never see them.
        expect(hermesModeForPreference(undefined)).toEqual({})
        expect('model' in hermesModeForPreference(undefined)).toBe(false)
    })

    it('keeps null as the explicit Default reset request', () => {
        expect(hermesModeForPreference(null)).toEqual({ model: null })
    })

    it('forwards a concrete model verbatim', () => {
        const GLM = 'newapi:glm-5.3'
        expect(hermesModeForPreference(GLM)).toEqual({ model: GLM })
    })

    it('attaches the permission mode only once one is set', () => {
        expect(hermesModeForPreference(GLM_MODEL)).toEqual({ model: GLM_MODEL })
        expect(hermesModeForPreference(GLM_MODEL, 'yolo')).toEqual({ model: GLM_MODEL, permissionMode: 'yolo' })
        expect(hermesModeForPreference(undefined, 'safe-yolo')).toEqual({ permissionMode: 'safe-yolo' })
    })
})
