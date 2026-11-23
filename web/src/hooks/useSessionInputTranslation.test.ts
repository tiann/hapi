import { describe, expect, it } from 'vitest'
import { resolveInputTranslationEnabled } from './useSessionInputTranslation'

describe('resolveInputTranslationEnabled', () => {
    it('lets an explicit per-session choice win over the hub default', () => {
        expect(resolveInputTranslationEnabled(false, true)).toEqual({ enabled: false, fromDefault: false })
        expect(resolveInputTranslationEnabled(true, false)).toEqual({ enabled: true, fromDefault: false })
    })

    it('follows the hub default when the session has no choice', () => {
        expect(resolveInputTranslationEnabled(undefined, true)).toEqual({ enabled: true, fromDefault: true })
        expect(resolveInputTranslationEnabled(undefined, false)).toEqual({ enabled: false, fromDefault: true })
    })
})
