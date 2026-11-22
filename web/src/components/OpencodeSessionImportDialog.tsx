import type { LocalSessionListItem } from '@/lib/localSessionImport'
import { useTranslation } from '@/lib/use-translation'
import { LocalSessionImportDialog } from '@/components/LocalSessionImportDialog'

/** OpenCode-flavored wrapper around the generic import dialog. */
export function OpencodeSessionImportDialog(props: {
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
                title: t('opencodeSync.dialog.title'),
                description: t('opencodeSync.dialog.description'),
                concurrentWarning: t('opencodeSync.dialog.concurrentWarning'),
                loading: t('opencodeSync.loading'),
                empty: t('opencodeSync.empty'),
                selectedCount: t('opencodeSync.selectedCount'),
                clearAll: t('opencodeSync.clearAll'),
                selectAll: t('opencodeSync.selectAll'),
                allDirectories: t('opencodeSync.allDirectories'),
                search: t('opencodeSync.search'),
                imported: t('opencodeSync.imported'),
                importing: t('opencodeSync.importing'),
                confirm: t('opencodeSync.confirm'),
                cancel: t('button.cancel')
            }}
        />
    )
}