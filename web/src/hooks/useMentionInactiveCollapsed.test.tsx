import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useMentionInactiveCollapsed } from './useMentionInactiveCollapsed'

const key = 'hapi-mention-inactive-collapsed'

describe('useMentionInactiveCollapsed', () => {
    beforeEach(() => localStorage.clear())

    it('defaults off, persists changes, and synchronizes mounted consumers', () => {
        const first = renderHook(() => useMentionInactiveCollapsed())
        const second = renderHook(() => useMentionInactiveCollapsed())
        expect(first.result.current.mentionInactiveCollapsed).toBe(false)
        act(() => first.result.current.setMentionInactiveCollapsed(true))
        expect(second.result.current.mentionInactiveCollapsed).toBe(true)
        expect(localStorage.getItem(key)).toBe('true')
        const remounted = renderHook(() => useMentionInactiveCollapsed())
        expect(remounted.result.current.mentionInactiveCollapsed).toBe(true)
        act(() => second.result.current.setMentionInactiveCollapsed(false))
        expect(first.result.current.mentionInactiveCollapsed).toBe(false)
        expect(localStorage.getItem(key)).toBeNull()
    })

    it('updates on changes and clears from another tab', () => {
        const hook = renderHook(() => useMentionInactiveCollapsed())
        act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: 'true' })))
        expect(hook.result.current.mentionInactiveCollapsed).toBe(true)
        act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })))
        expect(hook.result.current.mentionInactiveCollapsed).toBe(false)
    })
})
