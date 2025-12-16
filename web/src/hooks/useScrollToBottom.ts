import { useEffect, useRef, type RefObject } from 'react'

export function useScrollToBottom(
    deps: readonly unknown[],
    options?: { thresholdPx?: number }
): RefObject<HTMLDivElement | null> {
    const containerRef = useRef<HTMLDivElement>(null)
    const stickToBottomRef = useRef(true)

    useEffect(() => {
        const el = containerRef.current
        if (!el) return

        const thresholdPx = options?.thresholdPx ?? 120

        const onScroll = () => {
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
            stickToBottomRef.current = distanceFromBottom < thresholdPx
        }

        el.addEventListener('scroll', onScroll, { passive: true })
        onScroll()

        return () => {
            el.removeEventListener('scroll', onScroll)
        }
    }, [options?.thresholdPx])

    useEffect(() => {
        const el = containerRef.current
        if (!el) return
        if (!stickToBottomRef.current) return

        el.scrollTo({ top: el.scrollHeight })
    }, deps)

    return containerRef
}
