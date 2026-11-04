import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSessionLastSeenAt, getSessionManualUnreadAt, getUnreadSessionCount, observeSessionReadStates } from '@/lib/sessionLastSeen'
import { useSelectedSessionSeen } from './useSelectedSessionSeen'

function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
    document.dispatchEvent(new Event('visibilitychange'))
}
function viewport(atBottom = true) {
    const element = document.createElement('div')
    Object.defineProperty(element, 'clientHeight', { value: 100 })
    Object.defineProperty(element, 'scrollHeight', { value: 200 })
    element.scrollTop = atBottom ? 100 : 0
    return { current: element }
}
const content = { current: document.createElement('div') }
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(100) })

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); setVisibility('visible') })
afterEach(() => { vi.useRealTimers(); setVisibility('visible') })

describe('rendered read receipt', () => {
    it('waits for visible rendered tail and uses only its observed revision', async () => {
        setVisibility('hidden')
        const view = viewport()
        const { rerender } = renderHook(({ revision }) => useSelectedSessionSeen('s', revision, 0, view, content), {
            initialProps: { revision: 2 },
        })
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(0)
        rerender({ revision: 3 })
        act(() => setVisibility('visible'))
        expect(getSessionLastSeenAt('s')).toBe(0)
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(3)
    })

    it('does not clear unread while browsing history or when no loaded receipt exists', async () => {
        const view = viewport(false)
        const { rerender } = renderHook(({ revision }: { revision?: number }) => useSelectedSessionSeen('s', revision, 0, view, content), {
            initialProps: { revision: 3 as number | undefined },
        })
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(0)
        rerender({ revision: undefined })
        view.current.scrollTop = 100
        act(() => view.current.dispatchEvent(new Event('scroll')))
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(0)
        rerender({ revision: 3 })
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(3)
    })

    it('hides output that arrives ahead of the rendered tail only while following it', async () => {
        const view = viewport(false)
        const head = { id: 's', contentRevision: 4 }
        const { rerender, unmount } = renderHook(({ revision }: { revision?: number }) => useSelectedSessionSeen('s', revision, 0, view, content), {
            initialProps: { revision: 3 as number | undefined },
        })
        expect(getUnreadSessionCount([head])).toBe(0)
        rerender({ revision: undefined })
        expect(getUnreadSessionCount([head])).toBe(1)
        rerender({ revision: 3 })
        act(() => setVisibility('hidden'))
        expect(getUnreadSessionCount([head])).toBe(1)
        act(() => setVisibility('visible'))
        expect(getUnreadSessionCount([head])).toBe(0)
        unmount()
        expect(getUnreadSessionCount([head])).toBe(1)
        expect(getSessionLastSeenAt('s')).toBe(0)
    })

    it('read-state SSE alone cannot clear a manual unread choice', async () => {
        const view = viewport()
        const { rerender } = renderHook(({ version }) => useSelectedSessionSeen('s', 3, version, view, content), {
            initialProps: { version: 0 },
        })
        await settle()
        observeSessionReadStates([{ id: 's', readState: { readRevision: 3, version: 2, manualUnread: true } }])
        rerender({ version: 2 })
        act(() => view.current.dispatchEvent(new Event('scroll')))
        await settle()
        expect(getSessionManualUnreadAt('s')).toBe(0)
    })
})
