import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDragOver } from './useDragOver'

function makeDragEvent(type: string, types: string[]): Event {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
        value: { types },
        configurable: true,
    })
    return event
}

describe('useDragOver', () => {
    it('prevents the browser default when a file is dropped outside a zone', () => {
        // Regression: a file dropped on the document (e.g. the sidebar) must not
        // trigger the browser's file-open/navigation behaviour.
        const { unmount } = renderHook(() => useDragOver())
        const event = makeDragEvent('drop', ['Files'])
        act(() => {
            document.dispatchEvent(event)
        })
        expect(event.defaultPrevented).toBe(true)
        unmount()
    })

    it('does not prevent default for a non-file drop', () => {
        const { unmount } = renderHook(() => useDragOver())
        const event = makeDragEvent('drop', ['text/plain'])
        act(() => {
            document.dispatchEvent(event)
        })
        expect(event.defaultPrevented).toBe(false)
        unmount()
    })

    it('also prevents default on dragover for files so the drop can be cancelled', () => {
        const { unmount } = renderHook(() => useDragOver())
        const event = makeDragEvent('dragover', ['Files'])
        act(() => {
            document.dispatchEvent(event)
        })
        expect(event.defaultPrevented).toBe(true)
        unmount()
    })

    it('tracks file-drag state and clears it on drop', () => {
        const { result, unmount } = renderHook(() => useDragOver())
        expect(result.current).toBe(false)

        act(() => {
            document.dispatchEvent(makeDragEvent('dragenter', ['Files']))
        })
        expect(result.current).toBe(true)

        act(() => {
            document.dispatchEvent(makeDragEvent('drop', ['Files']))
        })
        expect(result.current).toBe(false)
        unmount()
    })
})
