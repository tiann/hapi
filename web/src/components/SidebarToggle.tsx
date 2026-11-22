import { useCallback, useRef, type MouseEvent, type PointerEventHandler } from 'react'

export function useSidebarToggleFocus() {
    const transferPending = useRef(false)
    const markActivation = (event: MouseEvent<HTMLButtonElement>) => {
        transferPending.current = event.detail === 0
    }
    const focusNewButton = useCallback((button: HTMLButtonElement | null) => {
        if (!button || !transferPending.current) return
        transferPending.current = false
        button.focus({ preventScroll: true })
    }, [])
    return { markActivation, focusNewButton }
}

type SidebarToggleFocus = ReturnType<typeof useSidebarToggleFocus>

function SidebarIcon(props: { direction: 'hide' | 'show'; className?: string }) {
    const arrowPath = props.direction === 'hide'
        ? 'M15 12l-6 8 6 8'
        : 'M9 12l6 8-6 8'

    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 40"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            shapeRendering="geometricPrecision"
            className={props.className}
            aria-hidden="true"
        >
            <rect x="3" y="2" width="18" height="36" rx="3" fill="var(--app-bg)" />
            <path d={arrowPath} />
        </svg>
    )
}

export function SidebarResizeHandle(props: {
    canHide: boolean
    hideLabel: string
    isDragging?: boolean
    toggleFocus?: SidebarToggleFocus
    onHide: () => void
    onPointerDown: PointerEventHandler<HTMLDivElement>
}) {
    return (
        <div
            className="sidebar-resize-handle hidden split:block shrink-0"
            data-dragging={props.isDragging || undefined}
            onPointerDown={props.onPointerDown}
        >
            {props.canHide ? (
                <button
                    type="button"
                    className="sidebar-hide-button"
                    aria-label={props.hideLabel}
                    title={props.hideLabel}
                    onPointerDown={(event) => event.stopPropagation()}
                    ref={props.toggleFocus?.focusNewButton}
                    onClick={(event) => {
                        props.toggleFocus?.markActivation(event)
                        props.onHide()
                    }}
                >
                    <SidebarIcon direction="hide" />
                </button>
            ) : null}
        </div>
    )
}

export function SidebarShowButton(props: {
    showLabel: string
    toggleFocus?: SidebarToggleFocus
    onShow: () => void
}) {
    return (
        <button
            type="button"
            className="sidebar-show-button hidden split:flex"
            aria-label={props.showLabel}
            title={props.showLabel}
            ref={props.toggleFocus?.focusNewButton}
            onClick={(event) => {
                props.toggleFocus?.markActivation(event)
                props.onShow()
            }}
        >
            <SidebarIcon direction="show" />
        </button>
    )
}
