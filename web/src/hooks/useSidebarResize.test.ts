import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useSidebarResize } from './useSidebarResize'

function pointer(type: string, clientX: number) {
    const event = new MouseEvent(type, { clientX, bubbles: true }) as MouseEvent & { pointerId: number }
    Object.defineProperty(event, 'pointerId', { value: 1 })
    return event
}

function startDrag(onPointerDown: (e: React.PointerEvent) => void, clientX: number) {
    const handle = document.createElement('div')
    onPointerDown({
        preventDefault: () => {},
        currentTarget: handle,
        clientX,
        pointerId: 1,
    } as unknown as React.PointerEvent)
}

describe('useSidebarResize', () => {
    afterEach(() => localStorage.clear())

    it('widens a right-side panel when dragging left and persists under its own key', () => {
        const { result } = renderHook(() => useSidebarResize({
            storageKey: 'test-panel-width',
            minWidth: 300,
            maxWidth: 800,
            defaultWidth: 400,
            side: 'right',
        }))
        expect(result.current.width).toBe(400)

        act(() => startDrag(result.current.onPointerDown, 1000))
        act(() => { document.dispatchEvent(pointer('pointermove', 900)) })
        expect(result.current.width).toBe(500)
        act(() => { document.dispatchEvent(pointer('pointerup', 900)) })

        expect(localStorage.getItem('test-panel-width')).toBe('500')
        expect(localStorage.getItem('hapi-sidebar-width')).toBeNull()
    })

    it('keeps the default left-sidebar behavior', () => {
        const { result } = renderHook(() => useSidebarResize())
        expect(result.current.width).toBe(420)

        act(() => startDrag(result.current.onPointerDown, 400))
        act(() => { document.dispatchEvent(pointer('pointermove', 450)) })
        expect(result.current.width).toBe(470)
    })
})
