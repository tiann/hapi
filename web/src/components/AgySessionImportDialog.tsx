import type { LocalSessionListItem } from '@/lib/localSessionImport'
import { useTranslation } from '@/lib/use-translation'
import { LocalSessionImportDialog } from '@/components/LocalSessionImportDialog'

/** Antigravity-flavored wrapper around the generic import dialog. */
export function AgySessionImportDialog(props: {
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
                title: t('agyImport.dialog.title'),
                description: t('agyImport.dialog.description'),
                concurrentWarning: t('agyImport.dialog.concurrentWarning'),
                loading: t('agyImport.loading'),
                empty: t('agyImport.empty'),
                selectedCount: t('agyImport.selectedCount'),
                clearAll: t('agyImport.clearAll'),
                selectAll: t('agyImport.selectAll'),
                allDirectories: t('agyImport.allDirectories'),
                search: t('agyImport.search'),
                imported: t('agyImport.imported'),
                importing: t('agyImport.importing'),
                confirm: t('agyImport.confirm'),
                cancel: t('button.cancel')
            }}
        />
    )
}
