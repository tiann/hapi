import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useMentionActiveSessionsOnly } from './useMentionActiveSessionsOnly'

const key = 'hapi-mention-active-sessions-only'

describe('useMentionActiveSessionsOnly', () => {
    beforeEach(() => localStorage.clear())

    it('defaults off, persists changes, and synchronizes mounted consumers', () => {
        const first = renderHook(() => useMentionActiveSessionsOnly())
        const second = renderHook(() => useMentionActiveSessionsOnly())
        expect(first.result.current.mentionActiveSessionsOnly).toBe(false)
        act(() => first.result.current.setMentionActiveSessionsOnly(true))
        expect(second.result.current.mentionActiveSessionsOnly).toBe(true)
        expect(localStorage.getItem(key)).toBe('true')
        const remounted = renderHook(() => useMentionActiveSessionsOnly())
        expect(remounted.result.current.mentionActiveSessionsOnly).toBe(true)
        act(() => second.result.current.setMentionActiveSessionsOnly(false))
        expect(first.result.current.mentionActiveSessionsOnly).toBe(false)
        expect(localStorage.getItem(key)).toBeNull()
    })

    it('updates on changes and clears from another tab', () => {
        const hook = renderHook(() => useMentionActiveSessionsOnly())
        act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: 'true' })))
        expect(hook.result.current.mentionActiveSessionsOnly).toBe(true)
        act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })))
        expect(hook.result.current.mentionActiveSessionsOnly).toBe(false)
    })
})
