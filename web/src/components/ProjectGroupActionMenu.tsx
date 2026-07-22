import { useId } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { useAnchoredMenu } from '@/hooks/useAnchoredMenu'
import { CopyIcon } from '@/components/icons'

type ProjectGroupActionMenuProps = {
    isOpen: boolean
    onClose: () => void
    onCopyPath: () => void
    onArchiveAll: () => void
    canArchiveAll: boolean
    onCleanOldSessions: () => void
    oldSessionCount: number
    onDelete: () => void
    canDelete: boolean
    anchorPoint: { x: number; y: number }
    menuId?: string
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

export function ProjectGroupActionMenu(props: ProjectGroupActionMenuProps) {
    const { t } = useTranslation()
    const {
        isOpen,
        onClose,
        onCopyPath,
        onArchiveAll,
        canArchiveAll,
        onCleanOldSessions,
        oldSessionCount,
        onDelete,
        canDelete,
        anchorPoint,
        menuId
    } = props
    const { menuRef, menuStyle } = useAnchoredMenu({ isOpen, onClose, anchorPoint })
    const internalId = useId()
    const resolvedMenuId = menuId ?? `project-group-action-menu-${internalId}`
    const headingId = `${resolvedMenuId}-heading`

    const handleCopyPath = () => {
        onClose()
        onCopyPath()
    }

    const handleArchiveAll = () => {
        onClose()
        onArchiveAll()
    }

    const handleDelete = () => {
        onClose()
        onDelete()
    }

    const handleCleanOldSessions = () => {
        onClose()
        onCleanOldSessions()
    }

    if (!isOpen) return null

    const baseItemClassName =
        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'

    return (
        <div
            ref={menuRef}
            className="fixed z-50 min-w-[220px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg animate-menu-pop"
            style={menuStyle}
        >
            <div
                id={headingId}
                className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]"
            >
                {t('sessions.group.actions')}
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
                    onClick={handleCopyPath}
                >
                    <CopyIcon className="h-[18px] w-[18px] text-[var(--app-hint)]" />
                    {t('sessions.group.copyPath')}
                </button>

                <button
                    type="button"
                    role="menuitem"
                    disabled={!canArchiveAll}
                    className={`${baseItemClassName} ${canArchiveAll
                        ? 'text-red-500 hover:bg-red-500/10'
                        : 'cursor-not-allowed text-[var(--app-hint)] opacity-50'}`}
                    onClick={handleArchiveAll}
                >
                    <ArchiveIcon className={canArchiveAll ? 'text-red-500' : 'text-[var(--app-hint)]'} />
                    {t('sessions.group.archiveAll')}
                </button>

                <button
                    type="button"
                    role="menuitem"
                    disabled={oldSessionCount === 0}
                    title={oldSessionCount === 0 ? t('sessions.group.cleanOldHint') : undefined}
                    className={`${baseItemClassName} ${oldSessionCount > 0
                        ? 'hover:bg-[var(--app-subtle-bg)]'
                        : 'cursor-not-allowed text-[var(--app-hint)] opacity-50'}`}
                    onClick={handleCleanOldSessions}
                >
                    <TrashIcon className="text-[var(--app-hint)]" />
                    {t('sessions.group.cleanOld', { count: oldSessionCount })}
                </button>

                <div className="my-1 h-px bg-[var(--app-border)]" role="separator" />

                <button
                    type="button"
                    role="menuitem"
                    disabled={!canDelete}
                    title={canDelete ? undefined : t('sessions.group.deleteHint')}
                    className={`${baseItemClassName} ${canDelete
                        ? 'text-red-500 hover:bg-red-500/10'
                        : 'cursor-not-allowed text-[var(--app-hint)] opacity-50'}`}
                    onClick={handleDelete}
                >
                    <TrashIcon className={canDelete ? 'text-red-500' : 'text-[var(--app-hint)]'} />
                    {t('sessions.group.delete')}
                </button>
            </div>
        </div>
    )
}
