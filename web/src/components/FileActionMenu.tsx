import { useId } from 'react'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { usePlatform } from '@/hooks/usePlatform'
import { useAnchoredMenu, type AnchoredMenuPoint } from '@/hooks/useAnchoredMenu'
import { useTranslation } from '@/lib/use-translation'
import { CopyIcon, PlusCircleIcon } from '@/components/icons'

type FileActionMenuProps = {
    isOpen: boolean
    onClose: () => void
    /** Workspace-relative path, e.g. `src/routes/sessions/file.tsx`. */
    relativePath: string
    /** Absolute path resolved against the session working directory. */
    absolutePath: string
    anchorPoint: AnchoredMenuPoint
    onAddToComposer: () => void
    menuId?: string
}

export function FileActionMenu(props: FileActionMenuProps) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const {
        isOpen,
        onClose,
        relativePath,
        absolutePath,
        anchorPoint,
        onAddToComposer,
        menuId,
    } = props
    const { menuRef, menuStyle } = useAnchoredMenu({ isOpen, onClose, anchorPoint, align: 'start' })
    const internalId = useId()
    const resolvedMenuId = menuId ?? `file-action-menu-${internalId}`
    const headingId = `${resolvedMenuId}-heading`

    const handleCopy = async (value: string) => {
        onClose()
        try {
            await safeCopyToClipboard(value)
            haptic.notification('success')
        } catch {
            haptic.notification('error')
        }
    }

    const handleAddToComposer = () => {
        onClose()
        onAddToComposer()
    }

    if (!isOpen) return null

    const itemClassName =
        'flex w-full items-center gap-3 rounded-md py-2 pl-3 pr-[42px] text-left text-base transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'

    return (
        <div
            ref={menuRef}
            className="fixed z-50 box-border w-max max-w-[calc(100vw-16px)] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg animate-menu-pop"
            style={menuStyle}
        >
            <div
                id={headingId}
                className="max-w-[60vw] truncate px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]"
            >
                {t('file.menu.title')}
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
                    className={itemClassName}
                    title={relativePath}
                    onClick={() => void handleCopy(relativePath)}
                >
                    <CopyIcon className="h-[18px] w-[18px] text-[var(--app-hint)]" />
                    {t('file.menu.copyPath')}
                </button>

                <button
                    type="button"
                    role="menuitem"
                    className={itemClassName}
                    title={absolutePath}
                    onClick={() => void handleCopy(absolutePath)}
                >
                    <CopyIcon className="h-[18px] w-[18px] text-[var(--app-hint)]" />
                    {t('file.menu.copyAbsolutePath')}
                </button>

                <button
                    type="button"
                    role="menuitem"
                    className={itemClassName}
                    onClick={handleAddToComposer}
                >
                    <PlusCircleIcon className="h-[18px] w-[18px] text-[var(--app-hint)]" />
                    {t('file.menu.addToComposer')}
                </button>
            </div>
        </div>
    )
}
