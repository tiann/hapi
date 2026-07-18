import { afterEach, describe, expect, it, vi } from 'vitest'
import { shouldMarkSessionRead } from './readState'

function stubMatchMedia(matchesByQuery: Record<string, boolean>) {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
        matches: matchesByQuery[query] ?? false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })))
}

describe('shouldMarkSessionRead', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    it('requires both a visible document and focused window', () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)

        expect(shouldMarkSessionRead()).toBe(true)
    })

    it('does not mark read for visible but unfocused clients', () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(false)
        stubMatchMedia({})

        expect(shouldMarkSessionRead()).toBe(false)
    })

    it('allows visible touch clients to mark read even when hasFocus is unreliable', () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        vi.spyOn(document, 'hasFocus').mockReturnValue(false)
        stubMatchMedia({ '(pointer: coarse)': true })

        expect(shouldMarkSessionRead()).toBe(true)
    })

    it('does not mark read for hidden clients', () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        stubMatchMedia({ '(pointer: coarse)': true })

        expect(shouldMarkSessionRead()).toBe(false)
    })
})
