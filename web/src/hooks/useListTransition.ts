import { useLayoutEffect, useRef, type RefObject } from 'react'

type Rect = { top: number }

function escapeCssId(id: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(id)
    }
    return id.replace(/([^\w-])/g, '\\$1')
}

function querySessionEl(container: HTMLElement, id: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-session-id="${escapeCssId(id)}"]`)
}

export function useListTransition(opts: {
    listContainerRef: RefObject<HTMLElement | null>
    scrollContainerRef: RefObject<HTMLElement | null> | undefined
    selectedSessionId: string | null | undefined
    unfreezeCount: number
}) {
    const { listContainerRef, scrollContainerRef, selectedSessionId, unfreezeCount } = opts

    const prevRectsRef = useRef<Map<string, Rect>>(new Map())
    const prevSelectedOffsetRef = useRef<number | null>(null)
    const prevSelectedIdRef = useRef<string | null | undefined>(null)
    const prevUnfreezeCountRef = useRef(unfreezeCount)

    useLayoutEffect(() => {
        const listContainer = listContainerRef.current
        const scrollContainer = scrollContainerRef?.current
        const didUnfreeze = prevUnfreezeCountRef.current !== unfreezeCount
        prevUnfreezeCountRef.current = unfreezeCount

        if (didUnfreeze && listContainer) {
            // Step 1: Pin scroll position for selected session
            // Only pin if the selected session is the same one we captured the offset for
            const prevOffset = prevSelectedOffsetRef.current
            if (
                scrollContainer
                && selectedSessionId
                && selectedSessionId === prevSelectedIdRef.current
                && prevOffset !== null
            ) {
                const selectedEl = querySessionEl(listContainer, selectedSessionId)
                if (selectedEl) {
                    const containerRect = scrollContainer.getBoundingClientRect()
                    const selectedRect = selectedEl.getBoundingClientRect()
                    const newOffset = selectedRect.top - containerRect.top
                    const delta = newOffset - prevOffset
                    if (Math.abs(delta) > 1) {
                        scrollContainer.scrollTop += delta
                    }
                }
            }

            // Step 2: FLIP animate session items
            const prevRects = prevRectsRef.current
            if (prevRects.size > 0) {
                const items = listContainer.querySelectorAll<HTMLElement>('[data-session-id]')
                for (const item of items) {
                    const id = item.dataset.sessionId
                    if (!id) continue
                    const prev = prevRects.get(id)
                    if (!prev) continue

                    const curr = item.getBoundingClientRect()
                    const dy = prev.top - curr.top
                    if (Math.abs(dy) < 1) continue

                    if (typeof item.animate === 'function') {
                        item.animate(
                            [
                                { transform: `translateY(${dy}px)` },
                                { transform: 'translateY(0)' }
                            ],
                            { duration: 200, easing: 'ease-out' }
                        )
                    }
                }
            }
        }

        // Capture item positions on unfreeze or first render for FLIP baseline
        if (didUnfreeze || prevRectsRef.current.size === 0) {
            if (listContainer) {
                const rects = new Map<string, Rect>()
                const items = listContainer.querySelectorAll<HTMLElement>('[data-session-id]')
                for (const item of items) {
                    const id = item.dataset.sessionId
                    if (id) {
                        const rect = item.getBoundingClientRect()
                        rects.set(id, { top: rect.top })
                    }
                }
                prevRectsRef.current = rects
            }
        }

        // Always capture selected session's offset for scroll pinning
        // (cheap single querySelector; accounts for user scrolling while frozen)
        prevSelectedIdRef.current = selectedSessionId ?? null
        if (scrollContainer && selectedSessionId && listContainer) {
            const selectedEl = querySessionEl(listContainer, selectedSessionId)
            if (selectedEl) {
                const containerRect = scrollContainer.getBoundingClientRect()
                const selectedRect = selectedEl.getBoundingClientRect()
                prevSelectedOffsetRef.current = selectedRect.top - containerRect.top
            } else {
                prevSelectedOffsetRef.current = null
            }
        } else {
            prevSelectedOffsetRef.current = null
        }
    })
}
