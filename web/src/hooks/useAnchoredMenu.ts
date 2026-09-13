import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type RefObject,
} from 'react'

export type AnchoredMenuPoint = { x: number; y: number }

type MenuPosition = {
    top: number
    left: number
    transformOrigin: string
}

/**
 * Position and dismissal lifecycle for a pointer-anchored context menu.
 *
 * Shared by the session action menu and the file action menu: measures the
 * menu, opens above/below the pointer as space allows, clamps it inside the
 * viewport, dismisses on outside pointer-down / Escape, repositions on
 * resize/scroll, and focuses the first `menuitem` when it opens.
 */
export function useAnchoredMenu(options: {
    isOpen: boolean
    onClose: () => void
    anchorPoint: AnchoredMenuPoint
    /**
     * Horizontal alignment relative to the anchor. `center` suits a trigger
     * button (menu centered under it); `start` suits a pointer/context menu
     * (menu's left edge at the pointer).
     */
    align?: 'center' | 'start'
}): {
    menuRef: RefObject<HTMLDivElement | null>
    menuStyle: CSSProperties | undefined
} {
    const { isOpen, onClose, anchorPoint, align = 'center' } = options
    const menuRef = useRef<HTMLDivElement | null>(null)
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)

    const updatePosition = useCallback(() => {
        const menuEl = menuRef.current
        if (!menuEl) return

        const menuRect = menuEl.getBoundingClientRect()
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        const padding = 8
        const gap = 8

        const spaceBelow = viewportHeight - anchorPoint.y
        const spaceAbove = anchorPoint.y
        const openAbove = spaceBelow < menuRect.height + gap && spaceAbove > spaceBelow

        let top = openAbove ? anchorPoint.y - menuRect.height - gap : anchorPoint.y + gap
        // Center the menu on a trigger button, or start its left edge at a
        // pointer, then clamp it so it never leaves the viewport.
        let left = align === 'start' ? anchorPoint.x : anchorPoint.x - menuRect.width / 2
        const transformOrigin = openAbove
            ? 'bottom center'
            : align === 'start' ? 'top left' : 'top center'

        top = Math.min(Math.max(top, padding), viewportHeight - menuRect.height - padding)
        left = Math.min(Math.max(left, padding), viewportWidth - menuRect.width - padding)

        setMenuPosition({ top, left, transformOrigin })
    }, [align, anchorPoint])

    useLayoutEffect(() => {
        if (!isOpen) return
        updatePosition()
    }, [isOpen, updatePosition])

    useEffect(() => {
        if (!isOpen) {
            setMenuPosition(null)
            return
        }

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node
            if (menuRef.current?.contains(target)) return
            onClose()
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose()
            }
        }

        const handleReflow = () => {
            updatePosition()
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        window.addEventListener('resize', handleReflow)
        window.addEventListener('scroll', handleReflow, true)

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
            window.removeEventListener('resize', handleReflow)
            window.removeEventListener('scroll', handleReflow, true)
        }
    }, [isOpen, onClose, updatePosition])

    useEffect(() => {
        if (!isOpen) return

        const frame = window.requestAnimationFrame(() => {
            const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
            firstItem?.focus()
        })

        return () => window.cancelAnimationFrame(frame)
    }, [isOpen])

    const menuStyle: CSSProperties | undefined = menuPosition
        ? {
            top: `max(${menuPosition.top}px, calc(env(safe-area-inset-top) + 8px))`,
            left: menuPosition.left,
            transformOrigin: menuPosition.transformOrigin,
        }
        : undefined

    return { menuRef, menuStyle }
}
