import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { usePinInProgressSessions } from './usePinInProgressSessions'

describe('usePinInProgressSessions', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('synchronizes the setting between sidebar and settings instances', () => {
        const sidebar = renderHook(() => usePinInProgressSessions())
        const settings = renderHook(() => usePinInProgressSessions())

        act(() => settings.result.current.setPinInProgressSessions(true))

        expect(sidebar.result.current.pinInProgressSessions).toBe(true)
        expect(window.localStorage.getItem('hapi-pin-in-progress-sessions')).toBe('true')

        act(() => sidebar.result.current.setPinInProgressSessions(false))

        expect(settings.result.current.pinInProgressSessions).toBe(false)
        expect(window.localStorage.getItem('hapi-pin-in-progress-sessions')).toBeNull()
    })
})
