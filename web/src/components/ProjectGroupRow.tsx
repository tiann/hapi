import { useState, type ReactNode } from 'react'
import { MutationObserver, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import { useAddToast } from '@/lib/toast-context'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { queryKeys } from '@/lib/query-keys'
import { usePlatform } from '@/hooks/usePlatform'
import { useLongPress } from '@/hooks/useLongPress'
import { useAnchoredMenu } from '@/hooks/useAnchoredMenu'
import { sessionArchiveMutationKey } from '@/hooks/mutations/useSessionActions'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ArchiveIcon, CopyIcon, PlusIcon } from '@/components/icons'

/** Sidebar project-group header row with a right-click / long-press menu. */
export function ProjectGroupRow(props: {
    className: string
    directory: string
    displayName: string
    onArchiveAll?: () => void
    onClick?: () => void
    expanded?: boolean
    onNewSession?: () => void
    children: ReactNode
}) {
    const { directory, displayName, onArchiveAll, onClick, onNewSession } = props
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null)

    const closeMenu = () => setMenuPoint(null)
    const { menuRef, menuStyle } = useAnchoredMenu({
        isOpen: menuPoint !== null,
        onClose: closeMenu,
        anchorPoint: menuPoint ?? { x: 0, y: 0 },
        align: 'start'
    })
    // Touch long-press and right-click only; taps keep the row's native click.
    const { onTouchStart, onTouchMove, onTouchCancel, onContextMenu } = useLongPress({
        onLongPress: (point) => {
            haptic.impact('medium')
            setMenuPoint(point)
        }
    })

    const run = (action: () => void) => () => {
        closeMenu()
        action()
    }
    const itemClassName = 'flex w-full items-center gap-3 rounded-md py-2 pl-3 pr-[42px] text-left text-base transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'
    const iconClassName = 'h-[18px] w-[18px] text-[var(--app-hint)]'

    return (
        <>
            <div
                className={props.className}
                style={{ WebkitTouchCallout: 'none' }}
                title={directory}
                role="button"
                tabIndex={0}
                aria-expanded={props.expanded}
                aria-haspopup="menu"
                onClick={onClick && (() => { if (!menuPoint) onClick() })}
                onKeyDown={(event) => {
                    // Ignore keys bubbling from the copy / new-session buttons.
                    if (event.target !== event.currentTarget) return
                    const menuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
                    if (!menuKey && event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    if (menuKey || !onClick) {
                        const rect = event.currentTarget.getBoundingClientRect()
                        setMenuPoint({ x: rect.left, y: rect.bottom })
                    } else {
                        onClick()
                    }
                }}
                onTouchStart={(event) => {
                    // Copy / new-session buttons keep plain taps; no long-press there.
                    if (!(event.target as Element).closest('button')) onTouchStart(event)
                }}
                onTouchMove={onTouchMove}
                onTouchCancel={onTouchCancel}
                onContextMenu={onContextMenu}
            >
                {props.children}
            </div>

            {menuPoint ? (
                <div
                    ref={menuRef}
                    role="menu"
                    aria-label={displayName}
                    className="fixed z-50 box-border w-max max-w-[calc(100vw-16px)] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg animate-menu-pop"
                    style={menuStyle}
                >
                    <button
                        type="button"
                        role="menuitem"
                        className={itemClassName}
                        onClick={run(() => {
                            safeCopyToClipboard(directory).then(
                                () => haptic.notification('success'),
                                () => haptic.notification('error')
                            )
                        })}
                    >
                        <CopyIcon className={iconClassName} />
                        {t('file.menu.copyPath')}
                    </button>
                    {onNewSession ? (
                        <button type="button" role="menuitem" className={itemClassName} onClick={run(onNewSession)}>
                            <PlusIcon className={iconClassName} />
                            {t('sessions.group.new')}
                        </button>
                    ) : null}
                    {onArchiveAll ? (
                        <button type="button" role="menuitem" className={itemClassName} onClick={run(onArchiveAll)}>
                            <ArchiveIcon className={iconClassName} />
                            {t('sessions.group.archiveAll')}
                        </button>
                    ) : null}
                </div>
            ) : null}
        </>
    )
}

/** Owned by the list so moving between Combined sections does not unmount the request. */
export function ProjectArchiveDialog({ api, displayName, sessionIds, onClose }: {
    api: ApiClient | null
    displayName: string
    sessionIds: string[]
    onClose: () => void
}) {
    const { t } = useTranslation()
    const addToast = useAddToast()
    const queryClient = useQueryClient()
    const archiveAll = useMutation({
        mutationFn: async (sessionIds: string[]) => {
            if (!api) return
            // Per-session archive key so row spinners and the delete dialog's
            // waiting-for-archive guard see each request.
            const results = await Promise.allSettled(sessionIds.map((sessionId) => {
                const observer = new MutationObserver(queryClient, {
                    mutationKey: sessionArchiveMutationKey(sessionId),
                    mutationFn: () => api.archiveSession(sessionId)
                })
                // Detach once settled so the mutation can be garbage-collected.
                return observer.mutate().finally(() => observer.reset())
            }))
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            const failed = results.filter((r) => r.status === 'rejected').length
            if (failed > 0) {
                addToast({
                    title: t('dialog.archive.error'),
                    body: t('dialog.archiveAll.failed', { n: failed, total: results.length }),
                    sessionId: '',
                    url: ''
                })
            }
        }
    })

    const submittedIds = archiveAll.isPending ? archiveAll.variables : sessionIds
    return (
        <ConfirmDialog
            isOpen
            onClose={onClose}
            title={t('sessions.group.archiveAll')}
            description={t('dialog.archiveAll.description', { n: submittedIds.length, name: displayName })}
            confirmLabel={t('dialog.archive.confirm')}
            confirmingLabel={t('dialog.archive.confirming')}
            onConfirm={() => archiveAll.mutateAsync(sessionIds)}
            isPending={archiveAll.isPending}
            isConfirmDisabled={!api || sessionIds.length === 0}
            destructive
        />
    )
}
