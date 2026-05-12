import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_COMPOSER_ENTER_BEHAVIOR,
    getComposerEnterBehaviorOptions,
    getInitialComposerEnterBehavior,
} from './useComposerEnterBehavior'

describe('useComposerEnterBehavior helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('returns the allowed enter behavior options', () => {
        expect(getComposerEnterBehaviorOptions()).toEqual([
            { value: 'send', labelKey: 'settings.chat.enterBehavior.send' },
            { value: 'newline', labelKey: 'settings.chat.enterBehavior.newline' },
        ])
    })

    it('falls back to the default behavior for missing or invalid storage values', () => {
        expect(getInitialComposerEnterBehavior()).toBe(DEFAULT_COMPOSER_ENTER_BEHAVIOR)

        window.localStorage.setItem('hapi-composer-enter-behavior', 'invalid')
        expect(getInitialComposerEnterBehavior()).toBe(DEFAULT_COMPOSER_ENTER_BEHAVIOR)
    })

    it('reads a valid stored enter behavior', () => {
        window.localStorage.setItem('hapi-composer-enter-behavior', 'newline')

        expect(getInitialComposerEnterBehavior()).toBe('newline')
    })
})
