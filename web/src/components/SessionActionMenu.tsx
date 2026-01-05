import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type RefObject
} from 'react'

type SessionActionMenuProps = {
    isOpen: boolean
    onClose: () => void
    sessionActive: boolean
    onRename: () => void
    onArchive: () => void
    onDelete: () => void
    anchorRef?: RefObject<HTMLElement | null>
    align?: 'start' | 'end'
    menuId?: string
}

function EditIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            <path d="m15 5 4 4" />
        </svg>
    )
}

function ArchiveIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <rect width="20" height="5" x="2" y="3" rx="1" />
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
            <path d="M10 12h4" />
        </svg>
    )
}

function TrashIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            <line x1="10" x2="10" y1="11" y2="17" />
            <line x1="14" x2="14" y1="11" y2="17" />
        </svg>
    )
}

type MenuPosition = {
    top: number
    left: number
    transformOrigin: string
}

export function SessionActionMenu(props: SessionActionMenuProps) {
    const {
        isOpen,
        onClose,
        sessionActive,
        onRename,
        onArchive,
        onDelete,
        anchorRef,
        align = 'end',
        menuId
    } = props
    const menuRef = useRef<HTMLDivElement | null>(null)
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
    const internalId = useId()
    const resolvedMenuId = menuId ?? `session-action-menu-${internalId}`
    const headingId = `${resolvedMenuId}-heading`

    const handleRename = () => {
        onClose()
        onRename()
    }

    const handleArchive = () => {
        onClose()
        onArchive()
    }

    const handleDelete = () => {
        onClose()
        onDelete()
    }

    const updatePosition = useCallback(() => {
        const menuEl = menuRef.current
        if (!menuEl) return

        const menuRect = menuEl.getBoundingClientRect()
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        const padding = 8
        const gap = 8

        let top = (viewportHeight - menuRect.height) / 2
        let left = (viewportWidth - menuRect.width) / 2
        let transformOrigin = 'top center'

        const anchorEl = anchorRef?.current
        if (anchorEl) {
            const anchorRect = anchorEl.getBoundingClientRect()
            const spaceBelow = viewportHeight - anchorRect.bottom
            const spaceAbove = anchorRect.top
            const openAbove = spaceBelow < menuRect.height + gap && spaceAbove > spaceBelow

            top = openAbove ? anchorRect.top - menuRect.height - gap : anchorRect.bottom + gap
            if (align === 'start') {
                left = anchorRect.left
                transformOrigin = openAbove ? 'bottom left' : 'top left'
            } else {
                left = anchorRect.right - menuRect.width
                transformOrigin = openAbove ? 'bottom right' : 'top right'
            }
        }

        top = Math.min(Math.max(top, padding), viewportHeight - menuRect.height - padding)
        left = Math.min(Math.max(left, padding), viewportWidth - menuRect.width - padding)

        setMenuPosition({ top, left, transformOrigin })
    }, [align, anchorRef])

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
            if (anchorRef?.current?.contains(target)) return
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
    }, [anchorRef, isOpen, onClose, updatePosition])

    useEffect(() => {
        if (!isOpen) return

        const frame = window.requestAnimationFrame(() => {
            const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
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
        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'

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
                Session actions
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
                    className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                    onClick={handleRename}
                >
                    <EditIcon className="text-[var(--app-hint)]" />
                    Rename
                </button>

                {sessionActive ? (
                    <button
                        type="button"
                        role="menuitem"
                        className={`${baseItemClassName} text-red-500 hover:bg-red-500/10`}
                        onClick={handleArchive}
                    >
                        <ArchiveIcon className="text-red-500" />
                        Archive
                    </button>
                ) : (
                    <button
                        type="button"
                        role="menuitem"
                        className={`${baseItemClassName} text-red-500 hover:bg-red-500/10`}
                        onClick={handleDelete}
                    >
                        <TrashIcon className="text-red-500" />
                        Delete
                    </button>
                )}
            </div>
        </div>
    )
}
