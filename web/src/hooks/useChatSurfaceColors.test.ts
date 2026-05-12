import { beforeEach, describe, expect, it } from 'vitest'
import {
    buildChatSurfaceBackgroundValue,
    initializeChatSurfaceColors,
    normalizeChatSurfaceTint,
} from '@/hooks/useChatSurfaceColors'

describe('useChatSurfaceColors helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
        document.documentElement.style.removeProperty('--app-tool-card-aggregate-bg')
        document.documentElement.style.removeProperty('--app-chat-user-bg')
    })

    it('normalizes shorthand and full hex colors', () => {
        expect(normalizeChatSurfaceTint('#abc')).toBe('#AABBCC')
        expect(normalizeChatSurfaceTint('#a1b2c3')).toBe('#A1B2C3')
    })

    it('rejects invalid tint values', () => {
        expect(normalizeChatSurfaceTint('blue')).toBeNull()
        expect(normalizeChatSurfaceTint('#abcd')).toBeNull()
        expect(normalizeChatSurfaceTint(null)).toBeNull()
    })

    it('builds default CSS variable fallback when tint is absent', () => {
        expect(buildChatSurfaceBackgroundValue('aggregateToolCard', null)).toBe('var(--app-tool-card-aggregate-bg-default)')
        expect(buildChatSurfaceBackgroundValue('userMessage', null)).toBe('var(--app-chat-user-bg-default)')
    })

    it('builds color-mix values when a tint exists', () => {
        expect(buildChatSurfaceBackgroundValue('aggregateToolCard', '#4F7CFF')).toBe(
            'color-mix(in srgb, var(--app-tool-card-aggregate-bg-default) 84%, #4F7CFF 16%)'
        )
        expect(buildChatSurfaceBackgroundValue('userMessage', '#4F7CFF')).toBe(
            'color-mix(in srgb, var(--app-chat-user-bg-default) 82%, #4F7CFF 18%)'
        )
    })

    it('applies stored tints during initialization', () => {
        window.localStorage.setItem('hapi-aggregate-tool-card-tint', '#4f7cff')
        window.localStorage.setItem('hapi-user-message-tint', '#14b8a6')

        initializeChatSurfaceColors()

        expect(document.documentElement.style.getPropertyValue('--app-tool-card-aggregate-bg')).toBe(
            'color-mix(in srgb, var(--app-tool-card-aggregate-bg-default) 84%, #4F7CFF 16%)'
        )
        expect(document.documentElement.style.getPropertyValue('--app-chat-user-bg')).toBe(
            'color-mix(in srgb, var(--app-chat-user-bg-default) 82%, #14B8A6 18%)'
        )
    })
})
