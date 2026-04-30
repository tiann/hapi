import type React from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorPaneResize } from './useEditorPaneResize'

const STORAGE_KEY = 'hapi-editor-pane-sizes'

function pointerDown(clientX: number, clientY = 0, pointerId = 1): React.PointerEvent {
    return {
        clientX,
        clientY,
        pointerId,
        preventDefault: vi.fn(),
    } as unknown as React.PointerEvent
}

function dispatchPointer(type: 'pointermove' | 'pointerup' | 'pointercancel', options: { clientX?: number, clientY?: number, pointerId?: number } = {}) {
    const event = new Event(type)
    Object.assign(event, {
        clientX: options.clientX ?? 0,
        clientY: options.clientY ?? 0,
        pointerId: options.pointerId ?? 1,
    })
    document.dispatchEvent(event)
}

describe('useEditorPaneResize', () => {
    beforeEach(() => {
        window.localStorage.clear()
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
    })

    afterEach(() => {
        window.localStorage.clear()
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
    })

    it('returns defaults when localStorage is empty', () => {
        const { result } = renderHook(() => useEditorPaneResize())

        expect(result.current.leftWidth).toBe(260)
        expect(result.current.rightWidth).toBe(380)
        expect(result.current.terminalHeight).toBe(160)
        expect(result.current.isDragging).toBe(false)
    })

    it('loads persisted sizes and clamps out-of-range persisted values', () => {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
            leftWidth: 100,
            rightWidth: 999,
            terminalHeight: 50,
        }))

        const { result } = renderHook(() => useEditorPaneResize())

        expect(result.current.leftWidth).toBe(200)
        expect(result.current.rightWidth).toBe(640)
        expect(result.current.terminalHeight).toBe(100)
    })

    it('changes left width using positive deltaX and clamps to bounds', () => {
        const { result } = renderHook(() => useEditorPaneResize())

        act(() => {
            result.current.onLeftResizePointerDown(pointerDown(100))
        })
        act(() => {
            dispatchPointer('pointermove', { clientX: 500 })
        })

        expect(result.current.leftWidth).toBe(500)

        act(() => {
            dispatchPointer('pointermove', { clientX: 900 })
        })

        expect(result.current.leftWidth).toBe(500)
    })

    it('changes right width using inverse deltaX', () => {
        const { result } = renderHook(() => useEditorPaneResize())

        act(() => {
            result.current.onRightResizePointerDown(pointerDown(500))
        })
        act(() => {
            dispatchPointer('pointermove', { clientX: 400 })
        })

        expect(result.current.rightWidth).toBe(480)
    })

    it('changes terminal height using inverse deltaY', () => {
        const { result } = renderHook(() => useEditorPaneResize())

        act(() => {
            result.current.onTerminalResizePointerDown(pointerDown(0, 500))
        })
        act(() => {
            dispatchPointer('pointermove', { clientY: 420 })
        })

        expect(result.current.terminalHeight).toBe(240)
    })

    it('persists sizes to localStorage after drag', () => {
        const { result } = renderHook(() => useEditorPaneResize())

        act(() => {
            result.current.onLeftResizePointerDown(pointerDown(100))
        })
        act(() => {
            dispatchPointer('pointermove', { clientX: 140 })
        })
        act(() => {
            dispatchPointer('pointerup', { clientX: 140 })
        })

        expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
            leftWidth: 300,
            rightWidth: 380,
            terminalHeight: 160,
        })
    })

    it('sets body cursor and userSelect during drag and resets after pointerup', () => {
        const { result } = renderHook(() => useEditorPaneResize())

        act(() => {
            result.current.onRightResizePointerDown(pointerDown(100))
        })

        expect(result.current.isDragging).toBe(true)
        expect(document.body.style.userSelect).toBe('none')
        expect(document.body.style.cursor).toBe('col-resize')

        act(() => {
            dispatchPointer('pointerup', { clientX: 100 })
        })

        expect(result.current.isDragging).toBe(false)
        expect(document.body.style.userSelect).toBe('')
        expect(document.body.style.cursor).toBe('')
    })
})
