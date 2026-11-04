import { useId } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { usePlatform } from '@/hooks/usePlatform'
import { useAnchoredMenu } from '@/hooks/useAnchoredMenu'
import { CopyIcon } from '@/components/icons'

type GroupActionMenuProps = {
    isOpen: boolean
    onClose: () => void
    /** Directory the group collapses (the copy-path payload). */
    directory: string
    pinned: boolean
    onTogglePin: () => void
    onRename: () => void
    anchorPoint: { x: number; y: number }
    /** `center` suits the trigger button, `start` suits a long-press pointer. */
    align?: 'center' | 'start'
    menuId?: string
}

function PinIcon(props: { className?: string; filled?: boolean }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
            fill={props.filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M12 17v5" />
            <path d="M5 17h14" />
            <path d="M7 4V2h10v2l-2 5v4l2 2H7l2-2V9Z" />
        </svg>
    )
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

export function GroupActionMenu(props: GroupActionMenuProps) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const {
        isOpen,
        onClose,
        directory,
        pinned,
        onTogglePin,
        onRename,
        anchorPoint,
        align = 'center',
        menuId
    } = props
    const { menuRef, menuStyle } = useAnchoredMenu({ isOpen, onClose, anchorPoint, align })
    const internalId = useId()
    const resolvedMenuId = menuId ?? `group-action-menu-${internalId}`
    const headingId = `${resolvedMenuId}-heading`

    const handleTogglePin = () => {
        onClose()
        onTogglePin()
    }

    const handleRename = () => {
        onClose()
        onRename()
    }

    const handleCopyPath = async () => {
        onClose()
        try {
            await safeCopyToClipboard(directory)
            haptic.notification('success')
        } catch {
            haptic.notification('error')
        }
    }

    if (!isOpen) return null

    // The left text inset includes the icon and gap; mirror it on the right so
    // the text-to-border distance is symmetric without counting the icon twice.
    const baseItemClassName =
        'flex w-full items-center gap-3 rounded-md py-2 pl-3 pr-[42px] text-left text-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'

    return (
        <div
            ref={menuRef}
            className="fixed z-50 box-border w-max max-w-[calc(100vw-16px)] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg animate-menu-pop"
            style={menuStyle}
        >
            <div
                id={headingId}
                className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]"
            >
                {t('sessions.group.more')}
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
                    data-testid="group-menu-item-pin"
                    className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                    onClick={handleTogglePin}
                >
                    <PinIcon filled={pinned} className="text-[var(--app-hint)]" />
                    {t(pinned ? 'sessions.group.unpin' : 'sessions.group.pin')}
                </button>

                <button
                    type="button"
                    role="menuitem"
                    data-testid="group-menu-item-rename"
                    className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                    onClick={handleRename}
                >
                    <EditIcon className="text-[var(--app-hint)]" />
                    {t('sessions.group.rename')}
                </button>

                <button
                    type="button"
                    role="menuitem"
                    data-testid="group-menu-item-copy-path"
                    className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                    onClick={() => void handleCopyPath()}
                >
                    <CopyIcon className="h-[18px] w-[18px] text-[var(--app-hint)]" />
                    {t('sessions.group.copyPath')}
                </button>
            </div>
        </div>
    )
}
