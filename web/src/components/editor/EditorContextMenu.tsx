import { useEffect, useRef } from 'react'
import type { EditorTreeItem } from '@/types/editor'

export function EditorContextMenu(props: {
    filePath: string | null
    items: EditorTreeItem[]
    position: { x: number; y: number } | null
    onOpen: (items: EditorTreeItem[]) => void
    onNewFile: (filePath: string) => void
    onAddToChat: (items: EditorTreeItem[]) => void
    onCopyPath: (items: EditorTreeItem[]) => void | Promise<void>
    onCopyRelativePath: (items: EditorTreeItem[]) => void | Promise<void>
    onRefresh: (items: EditorTreeItem[]) => void
    onDelete: (items: EditorTreeItem[]) => void | Promise<void>
    onClose: () => void
}) {
    const menuRef = useRef<HTMLDivElement | null>(null)
    const filePath = props.filePath
    const position = props.position
    const items = props.items.length > 0
        ? props.items
        : (filePath ? [{ path: filePath, type: 'file' as const }] : [])

    useEffect(() => {
        if (!filePath || !position) return

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                props.onClose()
            }
        }
        const handleMouseDown = (event: MouseEvent) => {
            const menu = menuRef.current
            if (menu && event.target instanceof Node && !menu.contains(event.target)) {
                props.onClose()
            }
        }

        document.addEventListener('keydown', handleKeyDown)
        document.addEventListener('mousedown', handleMouseDown)
        return () => {
            document.removeEventListener('keydown', handleKeyDown)
            document.removeEventListener('mousedown', handleMouseDown)
        }
    }, [filePath, position, props])

    if (!filePath || !position) {
        return null
    }

    const handleOpen = () => {
        props.onOpen(items)
        props.onClose()
    }

    const handleAddToChat = () => {
        props.onAddToChat(items)
        props.onClose()
    }

    const handleNewFile = () => {
        props.onNewFile(filePath)
        props.onClose()
    }

    const handleCopyPath = async () => {
        await props.onCopyPath(items)
        props.onClose()
    }

    const handleCopyRelativePath = async () => {
        await props.onCopyRelativePath(items)
        props.onClose()
    }

    const handleRefresh = () => {
        props.onRefresh(items)
        props.onClose()
    }

    const handleDeleteFile = () => {
        void props.onDelete(items)
        props.onClose()
    }

    return (
        <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 min-w-[160px] rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] py-1 text-xs text-[var(--app-fg)] shadow-lg"
            style={{ left: position.x, top: position.y }}
        >
            <button
                type="button"
                role="menuitem"
                onClick={handleOpen}
                className="block w-full px-3 py-1.5 text-left hover:bg-[var(--app-subtle-bg)]"
            >
                Open in Editor
            </button>
            <button
                type="button"
                role="menuitem"
                onClick={handleNewFile}
                className="block w-full px-3 py-1.5 text-left hover:bg-[var(--app-subtle-bg)]"
            >
                New File
            </button>
            <button
                type="button"
                role="menuitem"
                onClick={handleAddToChat}
                className="block w-full px-3 py-1.5 text-left hover:bg-[var(--app-subtle-bg)]"
            >
                Add to Chat
            </button>
            <button
                type="button"
                role="menuitem"
                onClick={() => { void handleCopyPath() }}
                className="block w-full px-3 py-1.5 text-left hover:bg-[var(--app-subtle-bg)]"
            >
                Copy Path
            </button>
            <button
                type="button"
                role="menuitem"
                onClick={() => { void handleCopyRelativePath() }}
                className="block w-full px-3 py-1.5 text-left hover:bg-[var(--app-subtle-bg)]"
            >
                Copy Relative Path
            </button>
            <button
                type="button"
                role="menuitem"
                onClick={handleRefresh}
                className="block w-full px-3 py-1.5 text-left hover:bg-[var(--app-subtle-bg)]"
            >
                Refresh
            </button>
            <button
                type="button"
                role="menuitem"
                onClick={handleDeleteFile}
                className="block w-full px-3 py-1.5 text-left text-red-500 hover:bg-[var(--app-subtle-bg)]"
            >
                Delete
            </button>
        </div>
    )
}
