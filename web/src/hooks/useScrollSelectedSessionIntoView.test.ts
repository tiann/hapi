import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    SCROLL_SELECTED_SESSION_SETTLE_MS,
    findScrollableSessionRow,
    resolveSessionGroupHeaderInset,
    resolveSessionScrollDelta,
    useScrollSelectedSessionIntoView,
} from './useScrollSelectedSessionIntoView'

const VIEWPORT_TOP = 50
const VIEWPORT_HEIGHT = 100
const ROW_HEIGHT = 20
const ROW_COUNT = 20
const FRAME_MS = 16

const frames = new Map<number, FrameRequestCallback>()
let nextFrameHandle = 1
let clock = 0
/** Observers created by the hook, so tests can replay a layout change. */
const resizeCallbacks = new Set<ResizeObserverCallback>()

/** Stands in for the browser reporting that the list regained layout. */
function triggerResize(): void {
    for (const callback of [...resizeCallbacks]) {
        callback([], {} as ResizeObserver)
    }
}

/** Advances the stubbed clock one frame at a time, like a real rAF loop. */
function flushFrames(count = 1): void {
    for (let index = 0; index < count; index += 1) {
        clock += FRAME_MS
        const batch = [...frames.values()]
        frames.clear()
        for (const callback of batch) callback(clock)
    }
}

beforeEach(() => {
    frames.clear()
    nextFrameHandle = 1
    clock = 1_000
    resizeCallbacks.clear()
    vi.stubGlobal('ResizeObserver', class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe() { resizeCallbacks.add(this.callback) }
        unobserve() { resizeCallbacks.delete(this.callback) }
        disconnect() { resizeCallbacks.delete(this.callback) }
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const handle = nextFrameHandle++
        frames.set(handle, callback)
        return handle
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
        frames.delete(handle)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
})

function edges(top: number, height: number): DOMRect {
    return {
        top, bottom: top + height, height, y: top,
        left: 0, right: 0, width: 0, x: 0,
        toJSON: () => ({}),
    } as DOMRect
}

type List = {
    container: HTMLElement
    content: HTMLElement
    rows: HTMLElement[]
    /** Attach a row that was not in the list when the selection changed. */
    addRow: (sessionId: string, index: number) => HTMLElement
    /** Shorter than the full list while a project is still animating open. */
    setScrollHeight: (height: number) => void
    /** `display: none`, as the sidebar is on a narrow screen. */
    setHidden: (hidden: boolean) => void
}

/**
 * jsdom has no layout, so the list geometry is scripted: rows sit on a
 * `ROW_HEIGHT` grid inside a `VIEWPORT_HEIGHT` scroll port, and `scrollTop` is
 * clamped against `scrollHeight` like a real scroll container.
 */
const GROUP_HEADER_HEIGHT = 24

function createList(options: {
    scrollTop?: number
    collapsedRowIds?: string[]
    hidden?: boolean
    /** Wrap every row in a project group with a sticky header, as `SessionList` does. */
    groupHeaders?: boolean
    /** Render no rows at first, as a freshly created session's list does. */
    empty?: boolean
} = {}): List {
    const container = document.createElement('div')
    let scrollTop = options.scrollTop ?? 0
    let scrollHeight = ROW_COUNT * ROW_HEIGHT
    let hidden = options.hidden ?? false
    Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = Math.max(0, Math.min(scrollHeight - VIEWPORT_HEIGHT, value))
        },
    })
    Object.defineProperty(container, 'scrollHeight', { get: () => scrollHeight })
    container.getBoundingClientRect = () => hidden
        ? edges(0, 0)
        : edges(VIEWPORT_TOP, VIEWPORT_HEIGHT)

    const content = document.createElement('div')
    container.append(content)

    const makeRow = (sessionId: string, index: number): HTMLElement => {
        const row = document.createElement('button')
        row.className = 'session-list-item'
        row.dataset.sessionId = sessionId
        row.getBoundingClientRect = () => edges(
            VIEWPORT_TOP + index * ROW_HEIGHT - scrollTop,
            ROW_HEIGHT
        )
        return row
    }

    const rows = options.empty ? [] : Array.from({ length: ROW_COUNT }, (_, index) => {
        const row = makeRow(`session-${index}`, index)
        const panel = document.createElement('div')
        panel.className = 'collapsible-panel'
        if (!options.collapsedRowIds?.includes(`session-${index}`)) {
            panel.setAttribute('data-open', 'true')
        }
        panel.append(row)
        if (options.groupHeaders) {
            const group = document.createElement('div')
            group.setAttribute('data-session-scroll-anchor', '')
            const header = document.createElement('div')
            header.setAttribute('data-session-group-header', '')
            header.getBoundingClientRect = () => edges(VIEWPORT_TOP, GROUP_HEADER_HEIGHT)
            group.append(header, panel)
            content.append(group)
        } else {
            content.append(panel)
        }
        return row
    })

    document.body.append(container)
    return {
        container,
        content,
        rows,
        addRow: (sessionId, index) => {
            const row = makeRow(sessionId, index)
            const panel = document.createElement('div')
            panel.className = 'collapsible-panel'
            panel.setAttribute('data-open', 'true')
            panel.append(row)
            content.append(panel)
            return row
        },
        setScrollHeight: (height) => { scrollHeight = height },
        setHidden: (value) => { hidden = value },
    }
}

function renderScrollIntoView(container: HTMLElement, selectedSessionId: string | null) {
    // `SessionList` passes a stable `useRef` object; keep that identity here so
    // a re-render alone cannot restart the reveal.
    const containerRef = { current: container }
    return renderHook(
        ({ sessionId }: { sessionId: string | null }) =>
            useScrollSelectedSessionIntoView(containerRef, sessionId),
        { initialProps: { sessionId: selectedSessionId } }
    )
}

describe('resolveSessionScrollDelta', () => {
    const viewport = { top: 0, bottom: 100 }

    it.each([
        ['fully inside', { top: 10, bottom: 30 }, 0],
        ['flush with the top edge', { top: 0, bottom: 20 }, 0],
        ['flush with the bottom edge', { top: 80, bottom: 100 }, 0],
        ['below the fold', { top: 110, bottom: 130 }, 30],
        ['clipped by the bottom edge', { top: 90, bottom: 110 }, 10],
        ['above the fold', { top: -50, bottom: -30 }, -50],
        ['clipped by the top edge', { top: -10, bottom: 10 }, -10],
        ['taller than the viewport and already spanning it', { top: -20, bottom: 140 }, 0],
        ['taller than the viewport and above it', { top: -200, bottom: -40 }, -200],
        ['off by a subpixel', { top: 0.4, bottom: 100.4 }, 0],
    ])('returns the nearest-edge delta for a row %s', (_label, row, expected) => {
        expect(resolveSessionScrollDelta(viewport, row)).toBe(expected)
    })
})

describe('findScrollableSessionRow', () => {
    it('finds the row marked with the selected session id', () => {
        const { container, rows } = createList()
        expect(findScrollableSessionRow(container, 'session-3')).toBe(rows[3])
    })

    it('ignores rows of a collapsed project until it opens', () => {
        const { container, rows } = createList({ collapsedRowIds: ['session-3'] })
        expect(findScrollableSessionRow(container, 'session-3')).toBeNull()
        rows[3].closest('.collapsible-panel')!.setAttribute('data-open', 'true')
        expect(findScrollableSessionRow(container, 'session-3')).toBe(rows[3])
    })

    it('returns null for a session that is not in the list', () => {
        const { container } = createList()
        expect(findScrollableSessionRow(container, 'session-404')).toBeNull()
    })

    it('measures the row shell when the id is marked on an inner node', () => {
        const { container, rows } = createList()
        const row = rows[3]
        row.removeAttribute('data-session-id')
        const inner = document.createElement('div')
        inner.dataset.sessionId = 'session-3'
        row.append(inner)
        expect(findScrollableSessionRow(container, 'session-3')).toBe(row)
    })

    it('ignores a session id marked outside any row, such as a composer chip', () => {
        const { container } = createList()
        const chip = document.createElement('span')
        chip.dataset.sessionId = 'session-404'
        container.append(chip)
        expect(findScrollableSessionRow(container, 'session-404')).toBeNull()
    })
})

describe('resolveSessionGroupHeaderInset', () => {
    it('reports the sticky header height of the row\'s project group', () => {
        const { rows } = createList({ groupHeaders: true })
        expect(resolveSessionGroupHeaderInset(rows[3])).toBe(GROUP_HEADER_HEIGHT)
    })

    it('reports no inset for rows outside a project group', () => {
        const { rows } = createList()
        expect(resolveSessionGroupHeaderInset(rows[3])).toBe(0)
    })
})

describe('useScrollSelectedSessionIntoView', () => {
    it('reveals a selected row below the fold by its bottom edge only', () => {
        const { container } = createList()
        renderScrollIntoView(container, 'session-9')
        // Row 9 spans 180–200 in content space; the port shows 0–100.
        expect(container.scrollTop).toBe(100)
    })

    it('reveals a selected row above the fold by its top edge only', () => {
        const { container } = createList({ scrollTop: 200 })
        renderScrollIntoView(container, 'session-4')
        expect(container.scrollTop).toBe(80)
    })

    it('leaves the scroll position untouched when the row is already visible', () => {
        const { container } = createList({ scrollTop: 100 })
        renderScrollIntoView(container, 'session-7')
        expect(container.scrollTop).toBe(100)
        // Nothing to follow, so the frame loop never starts.
        expect(frames.size).toBe(0)
    })

    it('does nothing without a selected session', () => {
        const { container } = createList({ scrollTop: 100 })
        renderScrollIntoView(container, null)
        expect(container.scrollTop).toBe(100)
        expect(frames.size).toBe(0)
    })

    it('stops as soon as the reveal lands and the list stops moving', () => {
        const { container } = createList()
        renderScrollIntoView(container, 'session-9')
        expect(container.scrollTop).toBe(100)
        flushFrames()
        expect(frames.size).toBe(0)
    })

    it('does not re-scroll while the selection stays the same', () => {
        const { container } = createList()
        const { rerender } = renderScrollIntoView(container, 'session-9')
        flushFrames(3)

        // Stand in for a live session-list refresh after the user scrolled away:
        // selection is unchanged, so the list must stay where the user left it.
        container.scrollTop = 0
        rerender({ sessionId: 'session-9' })
        flushFrames(5)
        expect(container.scrollTop).toBe(0)
    })

    it('reveals the row once a newly selected session changes the selection', () => {
        const { container } = createList()
        const { rerender } = renderScrollIntoView(container, 'session-0')
        expect(container.scrollTop).toBe(0)
        rerender({ sessionId: 'session-19' })
        expect(container.scrollTop).toBe(300)
    })

    it('waits for a collapsed project to open before revealing its row', () => {
        const { container, rows } = createList({ collapsedRowIds: ['session-9'] })
        renderScrollIntoView(container, 'session-9')
        expect(container.scrollTop).toBe(0)

        flushFrames(3)
        expect(container.scrollTop).toBe(0)

        rows[9].closest('.collapsible-panel')!.setAttribute('data-open', 'true')
        flushFrames()
        expect(container.scrollTop).toBe(100)
    })

    it('keeps correcting while an opening project is still growing the list', () => {
        const { container, setScrollHeight } = createList()
        // Mid-animation the panel is short, so the browser clamps scrollTop.
        setScrollHeight(VIEWPORT_HEIGHT + 40)
        renderScrollIntoView(container, 'session-9')
        expect(container.scrollTop).toBe(40)

        setScrollHeight(ROW_COUNT * ROW_HEIGHT)
        flushFrames()
        expect(container.scrollTop).toBe(100)
    })

    it.each([['wheel'], ['touchmove'], ['pointerdown'], ['keydown']])(
        'stops following when the user takes over the scroll with %s',
        (eventName) => {
            // A scrollbar drag lands as pointerdown on the scroll container, and
            // PageUp/arrows arrive as keydown while a row inside has focus.
            const { container, setScrollHeight } = createList()
            setScrollHeight(VIEWPORT_HEIGHT + 40)
            renderScrollIntoView(container, 'session-9')
            expect(container.scrollTop).toBe(40)

            container.dispatchEvent(new Event(eventName))
            setScrollHeight(ROW_COUNT * ROW_HEIGHT)
            flushFrames(5)
            expect(container.scrollTop).toBe(40)
        }
    )

    it('gives up following after the settle window', () => {
        const { container, setScrollHeight } = createList()
        // A row that can never be revealed: the list never grows enough.
        setScrollHeight(VIEWPORT_HEIGHT + 40)
        renderScrollIntoView(container, 'session-9')
        flushFrames(Math.ceil(SCROLL_SELECTED_SESSION_SETTLE_MS / FRAME_MS) + 1)
        expect(frames.size).toBe(0)

        setScrollHeight(ROW_COUNT * ROW_HEIGHT)
        flushFrames(5)
        expect(container.scrollTop).toBe(40)
    })

    it('clears the sticky project header when revealing a row from above', () => {
        const { container } = createList({ scrollTop: 200, groupHeaders: true })
        renderScrollIntoView(container, 'session-4')
        // Row 4 starts at 80 in content space; stopping at 80 would park it
        // behind the 24px sticky header, so the reveal goes 24px further up.
        expect(container.scrollTop).toBe(80 - GROUP_HEADER_HEIGHT)
    })

    it('treats a row hidden behind the sticky project header as not visible', () => {
        const { container } = createList({ scrollTop: 90, groupHeaders: true })
        renderScrollIntoView(container, 'session-4')
        expect(container.scrollTop).toBe(80 - GROUP_HEADER_HEIGHT)
    })

    it('does not inset a row revealed by its bottom edge', () => {
        const { container } = createList({ groupHeaders: true })
        renderScrollIntoView(container, 'session-9')
        expect(container.scrollTop).toBe(100)
    })

    it('waits for a list with no layout before revealing the row', () => {
        const { container, setHidden } = createList({ hidden: true })
        renderScrollIntoView(container, 'session-9')
        expect(container.scrollTop).toBe(0)
        // Nothing is measurable, so no frames are burned while it has no box.
        expect(frames.size).toBe(0)

        setHidden(false)
        triggerResize()
        expect(container.scrollTop).toBe(100)
    })

    it('reveals a row that only arrives after the first attempt gave up', () => {
        // A session created through the spawn flow navigates on the next frame,
        // but its row does not exist until the sessions query has refetched.
        const { container, addRow } = createList({ empty: true })
        renderScrollIntoView(container, 'session-new')
        flushFrames(Math.ceil(SCROLL_SELECTED_SESSION_SETTLE_MS / FRAME_MS) + 2)
        expect(frames.size).toBe(0)
        expect(container.scrollTop).toBe(0)

        addRow('session-new', 9)
        triggerResize()
        expect(container.scrollTop).toBe(100)
    })

    it('does not re-reveal after a user gesture, even when the list keeps changing', () => {
        const { container, addRow } = createList({ empty: true })
        renderScrollIntoView(container, 'session-new')
        container.dispatchEvent(new Event('pointerdown'))

        addRow('session-new', 9)
        triggerResize()
        flushFrames(3)
        expect(container.scrollTop).toBe(0)
    })

    it('does not re-reveal a row it has already revealed', () => {
        const { container } = createList()
        renderScrollIntoView(container, 'session-9')
        expect(container.scrollTop).toBe(100)
        flushFrames(2)

        container.scrollTop = 0
        triggerResize()
        flushFrames(3)
        expect(container.scrollTop).toBe(0)
    })

    it('does not re-reveal on a later layout change once the reveal is done', () => {
        const { container } = createList()
        renderScrollIntoView(container, 'session-9')
        expect(container.scrollTop).toBe(100)
        flushFrames(2)

        container.scrollTop = 0
        triggerResize()
        flushFrames(5)
        expect(container.scrollTop).toBe(0)
    })

    it('stops observing the list content on unmount', () => {
        const { container } = createList({ hidden: true })
        const { unmount } = renderScrollIntoView(container, 'session-9')
        expect(resizeCallbacks.size).toBe(1)
        unmount()
        expect(resizeCallbacks.size).toBe(0)
    })

    it('stops following when the list unmounts', () => {
        const { container, setScrollHeight } = createList()
        setScrollHeight(VIEWPORT_HEIGHT + 40)
        const { unmount } = renderScrollIntoView(container, 'session-9')
        expect(frames.size).toBe(1)
        unmount()
        expect(frames.size).toBe(0)
    })
})
