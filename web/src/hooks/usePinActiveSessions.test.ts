import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { usePinActiveSessions } from './usePinActiveSessions'

describe('usePinActiveSessions', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    afterEach(() => {
        cleanup()
        localStorage.clear()
    })

    it('updates other hook consumers in the same tab', () => {
        const first = renderHook(() => usePinActiveSessions())
        const second = renderHook(() => usePinActiveSessions())

        act(() => first.result.current.setPinActiveSessions(true))

        expect(first.result.current.pinActiveSessions).toBe(true)
        expect(second.result.current.pinActiveSessions).toBe(true)
        expect(localStorage.getItem('hapi-pin-active-sessions')).toBe('true')
    })
})
