import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSidebarResize, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX } from './useSidebarResize'

// jsdom lacks PointerEvent — polyfill with MouseEvent
if (typeof globalThis.PointerEvent === 'undefined') {
    (globalThis as Record<string, unknown>).PointerEvent = class PointerEvent extends MouseEvent {
        constructor(type: string, init?: PointerEventInit) {
            super(type, init)
        }
    }
}

describe('useSidebarResize', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    afterEach(() => {
        localStorage.clear()
    })

    it('returns default width when no stored value', () => {
        const { result } = renderHook(() => useSidebarResize())
        expect(result.current.width).toBe(SIDEBAR_DEFAULT)
    })

    it('restores width from localStorage', () => {
        localStorage.setItem('hapi:sidebar-width', '500')
        const { result } = renderHook(() => useSidebarResize())
        expect(result.current.width).toBe(500)
    })

    it('clamps stored value to min', () => {
        localStorage.setItem('hapi:sidebar-width', '100')
        const { result } = renderHook(() => useSidebarResize())
        expect(result.current.width).toBe(SIDEBAR_MIN)
    })

    it('clamps stored value to max', () => {
        localStorage.setItem('hapi:sidebar-width', '9999')
        const { result } = renderHook(() => useSidebarResize())
        expect(result.current.width).toBe(SIDEBAR_MAX)
    })

    it('ignores non-numeric stored value', () => {
        localStorage.setItem('hapi:sidebar-width', 'garbage')
        const { result } = renderHook(() => useSidebarResize())
        expect(result.current.width).toBe(SIDEBAR_DEFAULT)
    })

    it('persists width to localStorage on change', () => {
        localStorage.setItem('hapi:sidebar-width', '400')
        const { result } = renderHook(() => useSidebarResize())

        // Simulate a resize via pointer events
        act(() => {
            const fakeEvent = {
                preventDefault: () => {},
                clientX: 400,
            } as React.PointerEvent
            result.current.handleResizeStart(fakeEvent)
        })

        // Simulate pointer move +50px
        act(() => {
            document.dispatchEvent(new PointerEvent('pointermove', { clientX: 450 }))
        })

        // Release
        act(() => {
            document.dispatchEvent(new PointerEvent('pointerup'))
        })

        expect(result.current.width).toBe(450)
        expect(localStorage.getItem('hapi:sidebar-width')).toBe('450')
    })

    it('clamps drag to min during resize', () => {
        localStorage.setItem('hapi:sidebar-width', '400')
        const { result } = renderHook(() => useSidebarResize())

        act(() => {
            result.current.handleResizeStart({
                preventDefault: () => {},
                clientX: 400,
            } as React.PointerEvent)
        })

        // Drag far left
        act(() => {
            document.dispatchEvent(new PointerEvent('pointermove', { clientX: 0 }))
        })
        act(() => {
            document.dispatchEvent(new PointerEvent('pointerup'))
        })

        expect(result.current.width).toBe(SIDEBAR_MIN)
    })

    it('clamps drag to max during resize', () => {
        localStorage.setItem('hapi:sidebar-width', '400')
        const { result } = renderHook(() => useSidebarResize())

        act(() => {
            result.current.handleResizeStart({
                preventDefault: () => {},
                clientX: 400,
            } as React.PointerEvent)
        })

        // Drag far right
        act(() => {
            document.dispatchEvent(new PointerEvent('pointermove', { clientX: 2000 }))
        })
        act(() => {
            document.dispatchEvent(new PointerEvent('pointerup'))
        })

        expect(result.current.width).toBe(SIDEBAR_MAX)
    })

    it('cleans up body styles after resize ends', () => {
        const { result } = renderHook(() => useSidebarResize())

        act(() => {
            result.current.handleResizeStart({
                preventDefault: () => {},
                clientX: 400,
            } as React.PointerEvent)
        })

        expect(document.body.style.cursor).toBe('col-resize')
        expect(document.body.style.userSelect).toBe('none')

        act(() => {
            document.dispatchEvent(new PointerEvent('pointerup'))
        })

        expect(document.body.style.cursor).toBe('')
        expect(document.body.style.userSelect).toBe('')
    })
})
