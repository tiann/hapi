import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type ScrollState = {
    hasOverflow: boolean
    atStart: boolean
    atEnd: boolean
}

export function ScrollableSurface(props: {
    children: ReactNode
    ariaLabel?: string
    className?: string
    contentClassName?: string
    resetKey?: string
    testId?: string
}) {
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const contentRef = useRef<HTMLDivElement | null>(null)
    const [scrollState, setScrollState] = useState<ScrollState>({
        hasOverflow: false,
        atStart: true,
        atEnd: true,
    })

    const updateScrollState = useCallback(() => {
        const element = scrollRef.current
        if (!element) return

        const maxScrollLeft = Math.max(element.scrollWidth - element.clientWidth, 0)
        setScrollState({
            hasOverflow: maxScrollLeft > 1,
            atStart: element.scrollLeft <= 1,
            atEnd: maxScrollLeft <= 1 || element.scrollLeft >= maxScrollLeft - 1,
        })
    }, [])

    useLayoutEffect(() => {
        const element = scrollRef.current
        if (!element) return

        element.scrollLeft = 0
        updateScrollState()
        window.addEventListener('resize', updateScrollState)

        if (typeof ResizeObserver === 'undefined') {
            return () => window.removeEventListener('resize', updateScrollState)
        }

        const observer = new ResizeObserver(updateScrollState)
        observer.observe(element)
        if (contentRef.current) {
            observer.observe(contentRef.current)
        }
        return () => {
            observer.disconnect()
            window.removeEventListener('resize', updateScrollState)
        }
    }, [props.resetKey, updateScrollState])

    return (
        <div className="relative min-w-0 flex-1">
            <div
                ref={scrollRef}
                data-testid={props.testId}
                role={scrollState.hasOverflow ? 'region' : undefined}
                tabIndex={scrollState.hasOverflow ? 0 : undefined}
                aria-label={scrollState.hasOverflow ? props.ariaLabel : undefined}
                onScroll={updateScrollState}
                className={cn(
                    // No custom pointer/touch handlers: native horizontal
                    // scrolling and long-press text selection should coexist.
                    'hapi-scrollable-surface w-full min-w-0 overflow-x-auto whitespace-nowrap',
                    props.className
                )}
            >
                <div ref={contentRef} className={cn('w-max min-w-full pr-1', props.contentClassName)}>
                    {props.children}
                </div>
            </div>
            {scrollState.hasOverflow && !scrollState.atStart ? (
                <span
                    data-testid={props.testId ? `${props.testId}-start-fade` : undefined}
                    className="pointer-events-none absolute inset-y-0 left-0 w-4 bg-gradient-to-r from-[var(--app-bg)] to-transparent"
                    aria-hidden="true"
                />
            ) : null}
            {scrollState.hasOverflow && !scrollState.atEnd ? (
                <span
                    data-testid={props.testId ? `${props.testId}-end-fade` : undefined}
                    className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-[var(--app-bg)] to-transparent"
                    aria-hidden="true"
                />
            ) : null}
        </div>
    )
}

export function ScrollableTitle(props: {
    text: string
    className?: string
    testId?: string
}) {
    return (
        <ScrollableSurface
            ariaLabel={props.text}
            className={props.className}
            resetKey={props.text}
            testId={props.testId}
        >
            {props.text}
        </ScrollableSurface>
    )
}
