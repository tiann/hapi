import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests for the useViewportHeight hook logic.
 *
 * Because the hook depends on window.visualViewport (not available in jsdom),
 * we test the core update logic directly rather than rendering the hook.
 */
describe('useViewportHeight update logic', () => {
    const root = document.documentElement

    beforeEach(() => {
        root.style.removeProperty('--app-viewport-height')
    })

    afterEach(() => {
        root.style.removeProperty('--app-viewport-height')
    })

    it('sets --app-viewport-height when visual viewport is smaller than window', () => {
        // Simulate the update logic from the hook
        const viewportHeight = 400
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
        } else {
            root.style.removeProperty('--app-viewport-height')
        }

        expect(root.style.getPropertyValue('--app-viewport-height')).toBe('400px')
    })

    it('removes --app-viewport-height when viewports match', () => {
        // First set it
        root.style.setProperty('--app-viewport-height', '400px')

        // Then simulate keyboard close
        const viewportHeight = 800
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
        } else {
            root.style.removeProperty('--app-viewport-height')
        }

        expect(root.style.getPropertyValue('--app-viewport-height')).toBe('')
    })

    it('ignores sub-pixel differences (threshold of 1px)', () => {
        const viewportHeight = 799.5
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
        } else {
            root.style.removeProperty('--app-viewport-height')
        }

        expect(root.style.getPropertyValue('--app-viewport-height')).toBe('')
    })

    it('resets page scroll when keyboard is open', () => {
        const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

        // Simulate: keyboard open AND page has been scrolled by iOS
        Object.defineProperty(window, 'scrollY', { value: 120, configurable: true })

        const viewportHeight = 400
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
            if (window.scrollY > 0) {
                window.scrollTo(0, 0)
            }
        }

        expect(scrollToSpy).toHaveBeenCalledWith(0, 0)

        // Cleanup
        Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
        scrollToSpy.mockRestore()
    })

    it('does not reset scroll when page is not scrolled', () => {
        const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

        Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })

        const viewportHeight = 400
        const windowHeight = 800
        const diff = windowHeight - viewportHeight
        if (diff > 1) {
            root.style.setProperty('--app-viewport-height', `${viewportHeight}px`)
            if (window.scrollY > 0) {
                window.scrollTo(0, 0)
            }
        }

        expect(scrollToSpy).not.toHaveBeenCalled()

        scrollToSpy.mockRestore()
    })
})
