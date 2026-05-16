import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_SESSION_PREVIEW_LIMIT,
    MAX_SESSION_PREVIEW_LIMIT,
    MIN_SESSION_PREVIEW_LIMIT,
    getInitialSessionPreviewLimit,
    normalizeSessionPreviewLimit,
} from './useSessionPreviewLimit'

describe('useSessionPreviewLimit helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('falls back to the default for missing or invalid values', () => {
        expect(getInitialSessionPreviewLimit()).toBe(DEFAULT_SESSION_PREVIEW_LIMIT)

        window.localStorage.setItem('hapi-session-preview-limit', 'invalid')
        expect(getInitialSessionPreviewLimit()).toBe(DEFAULT_SESSION_PREVIEW_LIMIT)

        window.localStorage.setItem('hapi-session-preview-limit', '12.5')
        expect(getInitialSessionPreviewLimit()).toBe(DEFAULT_SESSION_PREVIEW_LIMIT)
    })

    it('reads valid stored values', () => {
        window.localStorage.setItem('hapi-session-preview-limit', '12')

        expect(getInitialSessionPreviewLimit()).toBe(12)
    })

    it('clamps values to the supported range', () => {
        expect(normalizeSessionPreviewLimit(0)).toBe(MIN_SESSION_PREVIEW_LIMIT)
        expect(normalizeSessionPreviewLimit(120)).toBe(MAX_SESSION_PREVIEW_LIMIT)

        window.localStorage.setItem('hapi-session-preview-limit', '0')
        expect(getInitialSessionPreviewLimit()).toBe(MIN_SESSION_PREVIEW_LIMIT)

        window.localStorage.setItem('hapi-session-preview-limit', '120')
        expect(getInitialSessionPreviewLimit()).toBe(MAX_SESSION_PREVIEW_LIMIT)
    })
})
