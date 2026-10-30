import { useEffect, useRef, type RefObject } from 'react'

export const TRANSIENT_SCROLLBAR_HIDE_DELAY_MS = 1_000
export const TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE = 'data-scrollbar-visible'

export type TransientScrollbarSide = 'left' | 'right'

/**
 * Keeps a scoped scrollbar visible while its surface is being used, then
 * hides only the thumb after a short idle period without changing layout.
 */
export function useTransientScrollbar(
    ref: RefObject<HTMLElement | null>,
    side: TransientScrollbarSide = 'right'
): void {
    const hideTimerRef = useRef<number | null>(null)

    useEffect(() => {
        const element = ref.current
        const host = element?.parentElement
        if (!element || !host) return

        const fallback = document.createElement('span')
        fallback.className = `transient-scrollbar-fallback transient-scrollbar-fallback-${side}`
        fallback.setAttribute('aria-hidden', 'true')
        const thumb = document.createElement('span')
        thumb.className = 'transient-scrollbar-fallback-thumb'
        fallback.append(thumb)
        host.append(fallback)
        const addedHostClass = !host.classList.contains('scrollbar-auto-hide-container')
        host.classList.add('scrollbar-auto-hide-container')

        let hasFocusWithin = false
        let frameId: number | null = null
        let frameIsTimeout = false

        const clearHideTimer = () => {
            if (hideTimerRef.current !== null) {
                window.clearTimeout(hideTimerRef.current)
                hideTimerRef.current = null
            }
        }

        const hideWhenIdle = () => {
            hideTimerRef.current = null
            if (!hasFocusWithin) {
                setScrollbarVisible(false)
            }
        }

        const scheduleHide = () => {
            clearHideTimer()
            hideTimerRef.current = window.setTimeout(hideWhenIdle, TRANSIENT_SCROLLBAR_HIDE_DELAY_MS)
        }

        const setScrollbarVisible = (visible: boolean) => {
            if (visible) {
                element.setAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE, 'true')
                fallback.setAttribute('data-visible', 'true')
            } else {
                element.removeAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE)
                fallback.removeAttribute('data-visible')
            }
        }

        const updateFallbackThumb = () => {
            frameId = null
            const viewportHeight = element.clientHeight
            const scrollHeight = element.scrollHeight
            const maxScrollTop = scrollHeight - viewportHeight
            if (viewportHeight <= 0 || maxScrollTop <= 0) {
                thumb.style.display = 'none'
                return
            }

            const thumbHeight = Math.max(24, Math.round(viewportHeight * viewportHeight / scrollHeight))
            const maxThumbOffset = Math.max(0, viewportHeight - thumbHeight)
            const thumbOffset = maxScrollTop > 0
                ? maxThumbOffset * element.scrollTop / maxScrollTop
                : 0
            thumb.style.display = ''
            thumb.style.height = `${thumbHeight}px`
            thumb.style.transform = `translateY(${thumbOffset}px)`
        }

        const scheduleFallbackThumbUpdate = () => {
            if (frameId !== null) return
            if (typeof window.requestAnimationFrame === 'function') {
                frameIsTimeout = false
                frameId = window.requestAnimationFrame(updateFallbackThumb)
            } else {
                frameIsTimeout = true
                frameId = window.setTimeout(updateFallbackThumb, 0)
            }
        }

        const show = () => {
            setScrollbarVisible(true)
            scheduleHide()
        }

        const handleScroll = () => {
            show()
            scheduleFallbackThumbUpdate()
        }

        const handleFocusIn = () => {
            hasFocusWithin = true
            clearHideTimer()
            setScrollbarVisible(true)
        }

        const handleFocusOut = () => {
            hasFocusWithin = false
            scheduleHide()
        }

        element.addEventListener('scroll', handleScroll, { passive: true })
        element.addEventListener('focusin', handleFocusIn)
        element.addEventListener('focusout', handleFocusOut)

        let resizeObserver: ResizeObserver | null = null
        if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(() => {
                scheduleFallbackThumbUpdate()
            })
            resizeObserver.observe(element)
            if (element.firstElementChild) {
                resizeObserver.observe(element.firstElementChild)
            }
        }

        const activeElement = document.activeElement
        hasFocusWithin = activeElement === element || Boolean(activeElement && element.contains(activeElement))
        if (hasFocusWithin) {
            handleFocusIn()
        } else {
            show()
        }
        updateFallbackThumb()

        return () => {
            clearHideTimer()
            if (frameId !== null) {
                if (frameIsTimeout) {
                    window.clearTimeout(frameId)
                } else {
                    window.cancelAnimationFrame(frameId)
                }
                frameId = null
            }
            resizeObserver?.disconnect()
            element.removeEventListener('scroll', handleScroll)
            element.removeEventListener('focusin', handleFocusIn)
            element.removeEventListener('focusout', handleFocusOut)
            element.removeAttribute(TRANSIENT_SCROLLBAR_VISIBLE_ATTRIBUTE)
            fallback.remove()
            if (addedHostClass) {
                host.classList.remove('scrollbar-auto-hide-container')
            }
        }
    }, [ref, side])
}
