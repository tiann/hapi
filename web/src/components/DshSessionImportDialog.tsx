import type { LocalSessionListItem } from '@/lib/localSessionImport'
import { useTranslation } from '@/lib/use-translation'
import { LocalSessionImportDialog } from '@/components/LocalSessionImportDialog'

/** DSH-flavored wrapper around the generic import dialog. */
export function DshSessionImportDialog(props: {
    isOpen: boolean
    onClose: () => void
    sessions: LocalSessionListItem[]
    currentSessionId: string | null
    currentWorkDirectory?: string | null
    onConfirm: (sessionIds: string[]) => Promise<void>
    isPending: boolean
    isLoading: boolean
}) {
    const { t } = useTranslation()
    return (
        <LocalSessionImportDialog
            isOpen={props.isOpen}
            onClose={props.onClose}
            sessions={props.sessions}
            currentSessionId={props.currentSessionId}
            currentWorkDirectory={props.currentWorkDirectory}
            onConfirm={props.onConfirm}
            isPending={props.isPending}
            isLoading={props.isLoading}
            labels={{
                title: t('dshSync.dialog.title'),
                description: t('dshSync.dialog.description'),
                loading: t('dshSync.loading'),
                empty: t('dshSync.empty'),
                selectedCount: t('dshSync.selectedCount'),
                clearAll: t('dshSync.clearAll'),
                selectAll: t('dshSync.selectAll'),
                allDirectories: t('dshSync.allDirectories'),
                search: t('dshSync.search'),
                imported: t('dshSync.imported'),
                importing: t('dshSync.importing'),
                confirm: t('dshSync.confirm'),
                cancel: t('button.cancel')
            }}
        />
    )
}
