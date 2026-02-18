import { useLayoutEffect, useRef, type RefObject } from 'react'

type Rect = { top: number }

export function useListTransition(opts: {
    listContainerRef: RefObject<HTMLElement | null>
    scrollContainerRef: RefObject<HTMLElement | null> | undefined
    selectedSessionId: string | null | undefined
    unfreezeCount: number
}) {
    const { listContainerRef, scrollContainerRef, selectedSessionId, unfreezeCount } = opts

    const prevRectsRef = useRef<Map<string, Rect>>(new Map())
    const prevSelectedOffsetRef = useRef<number | null>(null)
    const prevUnfreezeCountRef = useRef(unfreezeCount)

    useLayoutEffect(() => {
        const listContainer = listContainerRef.current
        const scrollContainer = scrollContainerRef?.current
        const didUnfreeze = prevUnfreezeCountRef.current !== unfreezeCount
        prevUnfreezeCountRef.current = unfreezeCount

        if (didUnfreeze && listContainer) {
            // Step 1: Pin scroll position for selected session
            if (scrollContainer && selectedSessionId && prevSelectedOffsetRef.current !== null) {
                const selectedEl = listContainer.querySelector<HTMLElement>(
                    `[data-session-id="${CSS.escape(selectedSessionId)}"]`
                )
                if (selectedEl) {
                    const containerRect = scrollContainer.getBoundingClientRect()
                    const selectedRect = selectedEl.getBoundingClientRect()
                    const newOffset = selectedRect.top - containerRect.top
                    const delta = newOffset - prevSelectedOffsetRef.current
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

        // Always capture current positions for next transition
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

        // Capture selected session's offset for scroll pinning
        if (scrollContainer && selectedSessionId && listContainer) {
            const selectedEl = listContainer.querySelector<HTMLElement>(
                `[data-session-id="${CSS.escape(selectedSessionId)}"]`
            )
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
