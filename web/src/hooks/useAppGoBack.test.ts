import { describe, expect, it } from 'vitest'
import { getSettingsBackTarget } from './useAppGoBack'

describe('getSettingsBackTarget', () => {
    it.each([
        ['/settings', '/sessions'],
        ['/settings/general', '/settings'],
        ['/settings/display', '/settings'],
        ['/settings/voice', '/settings'],
        ['/settings/voice/voices', '/settings/voice'],
        ['/settings/voice/advanced', '/settings/voice'],
        ['/sessions', null],
    ])('maps %s to %s', (pathname, target) => {
        expect(getSettingsBackTarget(pathname)).toBe(target)
    })
})
