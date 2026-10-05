import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_PIN_IN_PROGRESS_SESSIONS_MODE,
    getInitialPinInProgressSessionsMode,
    getPinInProgressSessionsModeOptions,
    usePinInProgressSessionsMode,
} from './usePinInProgressSessionsMode'

describe('usePinInProgressSessionsMode helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('returns detailed before combined so the existing pinned layout remains the default', () => {
        expect(DEFAULT_PIN_IN_PROGRESS_SESSIONS_MODE).toBe('detailed')
        expect(getPinInProgressSessionsModeOptions()).toEqual([
            { value: 'combined', labelKey: 'settings.display.pinInProgressSessions.mode.combined' },
            { value: 'detailed', labelKey: 'settings.display.pinInProgressSessions.mode.detailed' },
        ])
        expect(getInitialPinInProgressSessionsMode()).toBe('detailed')
    })

    it('falls back to detailed for an invalid stored mode', () => {
        window.localStorage.setItem('hapi-pin-in-progress-sessions-mode', 'invalid')

        expect(getInitialPinInProgressSessionsMode()).toBe(DEFAULT_PIN_IN_PROGRESS_SESSIONS_MODE)
    })

    it('reads the combined mode from storage', () => {
        window.localStorage.setItem('hapi-pin-in-progress-sessions-mode', 'combined')

        expect(getInitialPinInProgressSessionsMode()).toBe('combined')
    })

    it('synchronizes mode changes between sidebar and settings instances', () => {
        const sidebar = renderHook(() => usePinInProgressSessionsMode())
        const settings = renderHook(() => usePinInProgressSessionsMode())

        act(() => sidebar.result.current.setPinInProgressSessionsMode('combined'))

        expect(settings.result.current.pinInProgressSessionsMode).toBe('combined')
        expect(window.localStorage.getItem('hapi-pin-in-progress-sessions-mode')).toBe('combined')

        act(() => settings.result.current.setPinInProgressSessionsMode('detailed'))

        expect(sidebar.result.current.pinInProgressSessionsMode).toBe('detailed')
        expect(window.localStorage.getItem('hapi-pin-in-progress-sessions-mode')).toBeNull()
    })
})
