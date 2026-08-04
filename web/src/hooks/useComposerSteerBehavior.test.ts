import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_COMPOSER_STEER_BEHAVIOR,
    getComposerSteerBehaviorOptions,
    getInitialComposerSteerBehavior,
    oppositeComposerSteerBehavior,
} from './useComposerSteerBehavior'

describe('useComposerSteerBehavior helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('returns the allowed steer behavior options', () => {
        expect(getComposerSteerBehaviorOptions()).toEqual([
            { value: 'queue', labelKey: 'settings.chat.steerBehavior.queue' },
            { value: 'steer', labelKey: 'settings.chat.steerBehavior.steer' },
        ])
    })

    it('defaults to queue so existing sessions keep the behaviour they had', () => {
        expect(DEFAULT_COMPOSER_STEER_BEHAVIOR).toBe('queue')
        expect(getInitialComposerSteerBehavior()).toBe('queue')

        window.localStorage.setItem('hapi-composer-steer-behavior', 'invalid')
        expect(getInitialComposerSteerBehavior()).toBe('queue')
    })

    it('reads a valid stored steer behavior', () => {
        window.localStorage.setItem('hapi-composer-steer-behavior', 'steer')

        expect(getInitialComposerSteerBehavior()).toBe('steer')
    })

    it('maps each behavior to the one the secondary send shortcut uses', () => {
        expect(oppositeComposerSteerBehavior('queue')).toBe('steer')
        expect(oppositeComposerSteerBehavior('steer')).toBe('queue')
    })
})
