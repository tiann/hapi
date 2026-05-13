import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
    getChatSurfaceColorPickerValue,
    getToolGroupBackgroundPreference,
    getUserMessageBackgroundPreference,
    initializeChatSurfaceColors,
    toPresetChatSurfaceColorPreference,
    useChatSurfaceColors,
} from '@/hooks/useChatSurfaceColors'

describe('useChatSurfaceColors', () => {
    beforeEach(() => {
        localStorage.clear()
        document.documentElement.removeAttribute('data-theme')
        document.documentElement.style.removeProperty('--app-tool-group-bg')
        document.documentElement.style.removeProperty('--app-chat-user-surface-bg')
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('falls back to default when storage is missing or invalid', () => {
        localStorage.setItem('hapi-tool-group-bg', 'preset:invalid')
        localStorage.setItem('hapi-user-message-bg', 'custom:not-a-color')

        expect(getToolGroupBackgroundPreference()).toBe('default')
        expect(getUserMessageBackgroundPreference()).toBe('default')
    })

    it('stores preset and custom preferences using stable string values', () => {
        const { result } = renderHook(() => useChatSurfaceColors())

        act(() => {
            result.current.setToolGroupBackground(toPresetChatSurfaceColorPreference('soft-blue'))
            result.current.setUserMessageBackground('custom:#88cc44')
        })

        expect(localStorage.getItem('hapi-tool-group-bg')).toBe('preset:soft-blue')
        expect(localStorage.getItem('hapi-user-message-bg')).toBe('custom:#88cc44')
        expect(result.current.toolGroupBackground).toBe('preset:soft-blue')
        expect(result.current.userMessageBackground).toBe('custom:#88cc44')
    })

    it('applies root css variables only for non-default preferences', () => {
        const { result } = renderHook(() => useChatSurfaceColors())

        expect(document.documentElement.style.getPropertyValue('--app-tool-group-bg')).toBe('')
        expect(document.documentElement.style.getPropertyValue('--app-chat-user-surface-bg')).toBe('')

        act(() => {
            result.current.setToolGroupBackground('preset:soft-green')
            result.current.setUserMessageBackground('custom:#88cc44')
        })

        expect(document.documentElement.style.getPropertyValue('--app-tool-group-bg')).toMatch(/^#/)
        expect(document.documentElement.style.getPropertyValue('--app-chat-user-surface-bg')).toMatch(/^#/)

        act(() => {
            result.current.setToolGroupBackground('default')
            result.current.setUserMessageBackground('default')
        })

        expect(document.documentElement.style.getPropertyValue('--app-tool-group-bg')).toBe('')
        expect(document.documentElement.style.getPropertyValue('--app-chat-user-surface-bg')).toBe('')
    })

    it('reapplies stored values during initialization', () => {
        localStorage.setItem('hapi-tool-group-bg', 'preset:soft-yellow')
        localStorage.setItem('hapi-user-message-bg', 'custom:#88cc44')

        initializeChatSurfaceColors()

        expect(document.documentElement.style.getPropertyValue('--app-tool-group-bg')).toMatch(/^#/)
        expect(document.documentElement.style.getPropertyValue('--app-chat-user-surface-bg')).toMatch(/^#/)
    })

    it('returns a valid picker value for default, preset, and custom preferences', () => {
        expect(getChatSurfaceColorPickerValue('default')).toBe('#f2f4f6')
        expect(getChatSurfaceColorPickerValue('preset:soft-blue')).toBe('#7db7ff')
        expect(getChatSurfaceColorPickerValue('custom:#88cc44')).toBe('#88cc44')
    })
})
