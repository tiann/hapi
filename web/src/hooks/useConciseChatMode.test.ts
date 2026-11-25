import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useConciseChatMode } from './useConciseChatMode'

const STORAGE_KEY = 'hapi-concise-chat-mode'

describe('useConciseChatMode', () => {
    beforeEach(() => {
        window.localStorage.clear()
        const { result } = renderHook(() => useConciseChatMode())
        act(() => result.current.setConciseChatMode(false))
    })

    it('persists the preference and removes it when restored to the default', () => {
        const { result } = renderHook(() => useConciseChatMode())

        act(() => result.current.setConciseChatMode(true))
        expect(result.current.conciseChatMode).toBe(true)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true')

        act(() => result.current.setConciseChatMode(false))
        expect(result.current.conciseChatMode).toBe(false)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('shares one value across hook instances in the same tab', () => {
        const header = renderHook(() => useConciseChatMode())
        const thread = renderHook(() => useConciseChatMode())

        act(() => header.result.current.setConciseChatMode(true))

        expect(thread.result.current.conciseChatMode).toBe(true)
    })

    it('follows changes made in other tabs', () => {
        const { result } = renderHook(() => useConciseChatMode())

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'true' }))
        })

        expect(result.current.conciseChatMode).toBe(true)
    })
})
