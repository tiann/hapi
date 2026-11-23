import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionReadState, SessionReadStateRequest } from '@hapi/protocol'
import { configureSessionReadState, markSessionUnread, getSessionLastSeenAt, getSessionManualUnreadAt, getUnreadSessionCount, observeSessionReadStates } from '@/lib/sessionLastSeen'
import { useSelectedSessionSeen } from './useSelectedSessionSeen'

function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
    document.dispatchEvent(new Event('visibilitychange'))
}
function viewport(atBottom = true) {
    const element = document.createElement('div')
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 200 })
    element.scrollTop = atBottom ? 100 : 0
    return { current: element }
}
const content = { current: document.createElement('div') }
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(100) })

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); setVisibility('visible') })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setVisibility('visible') })

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
        const view = viewport(true)
        const head = { id: 's', contentRevision: 4 }
        const { rerender, unmount } = renderHook(({ revision }: { revision?: number }) => useSelectedSessionSeen('s', revision, 0, view, content), {
            initialProps: { revision: 3 as number | undefined },
        })
        expect(getUnreadSessionCount([head])).toBe(0)
        view.current.scrollTop = 0
        act(() => view.current.dispatchEvent(new Event('scroll')))
        expect(getUnreadSessionCount([head])).toBe(1)
        view.current.scrollTop = 100
        act(() => view.current.dispatchEvent(new Event('scroll')))
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

    it('makes progress during continuous scrolling, DOM mutations and rendered revisions', async () => {
        const view = viewport()
        const { rerender } = renderHook(({ revision }) => useSelectedSessionSeen('s', revision, 0, view, content), {
            initialProps: { revision: 1 },
        })
        for (let revision = 2; revision <= 16; revision++) {
            rerender({ revision })
            content.current.textContent = String(revision)
            act(() => view.current.dispatchEvent(new Event('scroll')))
            await act(async () => { await vi.advanceTimersByTimeAsync(10) })
        }
        expect(getSessionLastSeenAt('s')).toBeGreaterThan(1)
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(16)
    })

    it('rechecks a viewport resize without waiting for a scroll or a message', async () => {
        let resize!: () => void
        const observe = vi.fn()
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: () => void) { resize = callback }
            observe = observe
            disconnect() {}
        })
        const view = viewport(false)
        renderHook(() => useSelectedSessionSeen('s', 3, 0, view, content))
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(0)
        expect(observe).toHaveBeenCalledWith(view.current)
        Object.defineProperty(view.current, 'clientHeight', { value: 200 })
        act(() => resize())
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(3)
    })

    it('acknowledges the visible end of the transcript before its trailing padding', async () => {
        const view = viewport(false)
        const messages = viewport()
        vi.spyOn(view.current, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 100, 100))
        vi.spyOn(messages.current, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 20, 100, 180))
        renderHook(() => useSelectedSessionSeen('s', 3, 0, view, messages))
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(3)
    })

    it('does not borrow a newer manual-unread version during layout', async () => {
        const view = viewport()
        const { rerender } = renderHook(({ version }) => useSelectedSessionSeen('s', 3, version, view, content), {
            initialProps: { version: 0 },
        })
        observeSessionReadStates([{ id: 's', readState: { readRevision: 2, version: 1, manualUnread: true } }])
        rerender({ version: 1 })
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(3)
        expect(getSessionManualUnreadAt('s')).toBe(0)
    })

    it('keeps the observed version of a revision waiting behind another frame', async () => {
        const view = viewport()
        observeSessionReadStates([{ id: 's', readState: { readRevision: 41, version: 3, manualUnread: false } }])
        const { rerender } = renderHook(({ revision, version }) => useSelectedSessionSeen('s', revision, version, view, content), {
            initialProps: { revision: 41, version: 3 },
        })
        rerender({ revision: 42, version: 3 })
        observeSessionReadStates([{ id: 's', readState: { readRevision: 41, version: 4, manualUnread: true } }])
        rerender({ revision: 42, version: 4 })
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(42)
        expect(getSessionManualUnreadAt('s')).toBe(0)
    })

    it('keeps a pending check across streaming growth and automatic scroll correction', async () => {
        const view = viewport()
        renderHook(() => useSelectedSessionSeen('s', 3, 0, view, content))
        for (let n = 1; n <= 10; n++) {
            Object.defineProperty(view.current, 'scrollHeight', { value: 200 + n * 40 })
            content.current.textContent = String(n)
            await act(async () => { await Promise.resolve() })
            view.current.scrollTop = view.current.scrollHeight - view.current.clientHeight
            act(() => view.current.dispatchEvent(new Event('scroll')))
            await act(async () => { await vi.advanceTimersByTimeAsync(10) })
        }
        expect(getSessionLastSeenAt('s')).toBe(3)
    })

    it('finishes a mature receipt when the tail is repinned after the animation callbacks', async () => {
        const view = viewport()
        const { result } = renderHook(() => useSelectedSessionSeen('s', 3, 0, view, content))
        view.current.scrollTop = 0
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(0)
        view.current.scrollTop = 100
        act(() => result.current())
        expect(getSessionLastSeenAt('s')).toBe(3)
    })

    it('sends an explicit local unread queued behind an in-flight read', async () => {
        const view = viewport()
        const sent: SessionReadStateRequest[] = []
        let resolve!: (value: { readState: SessionReadState }) => void
        const disconnect = configureSessionReadState('local-race', async (_id, request) => {
            sent.push({ ...request })
            if (request.type === 'read') return new Promise(r => { resolve = r })
            return { readState: { readRevision: 41, version: 2, manualUnread: true } }
        })
        try {
            const { rerender } = renderHook(({ revision }) => useSelectedSessionSeen('s', revision, 0, view, content), {
                initialProps: { revision: 41 },
            })
            rerender({ revision: 42 })
            await act(async () => { await vi.advanceTimersByTimeAsync(40) })
            expect(sent.map(r => r.type)).toEqual(['read'])
            act(() => markSessionUnread('s'))
            await settle()
            resolve({ readState: { readRevision: 41, version: 1, manualUnread: false } })
            await settle()
            expect(sent).toEqual([{ type: 'read', readRevision: 41, expectedVersion: 0 }, { type: 'unread', expectedVersion: 1 }])
            expect(getSessionManualUnreadAt('s')).toBe(0)
        } finally { disconnect() }
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
