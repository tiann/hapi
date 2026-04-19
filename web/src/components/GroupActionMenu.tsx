import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties
} from 'react'

import { ArrowUpIcon, ArrowDownIcon } from '@/components/icons/SortIcons'
import { useTranslation } from '@/lib/use-translation'

type GroupActionMenuProps = {
    isOpen: boolean
    onClose: () => void
    onMoveUp: () => void
    onMoveDown: () => void
    canMoveUp: boolean
    canMoveDown: boolean
    anchorPoint: { x: number; y: number }
    menuId?: string
}

type MenuPosition = {
    top: number
    left: number
    transformOrigin: string
}

export function GroupActionMenu(props: GroupActionMenuProps) {
    const { t } = useTranslation()
    const {
        isOpen,
        onClose,
        onMoveUp,
        onMoveDown,
        canMoveUp,
        canMoveDown,
        anchorPoint,
        menuId
    } = props
    const menuRef = useRef<HTMLDivElement | null>(null)
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
    const internalId = useId()
    const resolvedMenuId = menuId ?? `group-action-menu-${internalId}`
    const headingId = `${resolvedMenuId}-heading`

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
        let left = anchorPoint.x - menuRect.width / 2
        const transformOrigin = openAbove ? 'bottom center' : 'top center'

        top = Math.min(Math.max(top, padding), viewportHeight - menuRect.height - padding)
        left = Math.min(Math.max(left, padding), viewportWidth - menuRect.width - padding)

        setMenuPosition({ top, left, transformOrigin })
    }, [anchorPoint])

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
                return
            }

            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')
                if (!items || items.length === 0) return
                const current = document.activeElement as HTMLElement
                const index = Array.from(items).indexOf(current)
                const next = event.key === 'ArrowDown'
                    ? items[(index + 1) % items.length]
                    : items[(index - 1 + items.length) % items.length]
                next?.focus()
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
            const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
            firstItem?.focus()
        })

        return () => window.cancelAnimationFrame(frame)
    }, [isOpen])

    if (!isOpen) return null

    const menuStyle: CSSProperties | undefined = menuPosition
        ? {
            top: menuPosition.top,
            left: menuPosition.left,
            transformOrigin: menuPosition.transformOrigin
        }
        : undefined

    const baseItemClassName =
        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'

    return (
        <div
            ref={menuRef}
            className="fixed z-50 min-w-[200px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg animate-menu-pop"
            style={menuStyle}
        >
            <div
                id={headingId}
                className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]"
            >
                {t('group.more')}
            </div>
            <div
                id={resolvedMenuId}
                role="menu"
                aria-labelledby={headingId}
                className="flex flex-col gap-1"
            >
                <button
                    type="button"
                    role="menuitem"
                    className={`${baseItemClassName} ${canMoveUp ? 'hover:bg-[var(--app-subtle-bg)]' : 'opacity-40 cursor-default'}`}
                    onClick={() => {
                        if (!canMoveUp) return
                        onClose()
                        onMoveUp()
                    }}
                    disabled={!canMoveUp}
                    aria-disabled={!canMoveUp}
                >
                    <ArrowUpIcon className="text-[var(--app-hint)]" />
                    {t('group.action.moveUp')}
                </button>
                <button
                    type="button"
                    role="menuitem"
                    className={`${baseItemClassName} ${canMoveDown ? 'hover:bg-[var(--app-subtle-bg)]' : 'opacity-40 cursor-default'}`}
                    onClick={() => {
                        if (!canMoveDown) return
                        onClose()
                        onMoveDown()
                    }}
                    disabled={!canMoveDown}
                    aria-disabled={!canMoveDown}
                >
                    <ArrowDownIcon className="text-[var(--app-hint)]" />
                    {t('group.action.moveDown')}
                </button>
            </div>
        </div>
    )
}
