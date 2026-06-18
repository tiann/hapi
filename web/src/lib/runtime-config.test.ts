import { describe, expect, it } from 'vitest'
import { getPreviewBasepath, isPreviewUiMode, normalizeBaseUrl } from './runtime-config'

describe('preview runtime config', () => {
    it('normalizes vite base urls', () => {
        expect(normalizeBaseUrl(undefined)).toBe('/')
        expect(normalizeBaseUrl('/')).toBe('/')
        expect(normalizeBaseUrl('new')).toBe('/new/')
        expect(normalizeBaseUrl('/new')).toBe('/new/')
        expect(normalizeBaseUrl('/new/')).toBe('/new/')
    })

    it('detects only the /new preview basepath', () => {
        expect(getPreviewBasepath('/new/')).toBe('/new')
        expect(isPreviewUiMode('/new/')).toBe(true)
        expect(getPreviewBasepath('/')).toBeUndefined()
        expect(isPreviewUiMode('/')).toBe(false)
    })
})
