import type { LocalSessionListItem } from '@/lib/localSessionImport'
import { useTranslation } from '@/lib/use-translation'
import { LocalSessionImportDialog } from '@/components/LocalSessionImportDialog'

/** Pi-flavored wrapper around the generic import dialog. */
export function PiSessionImportDialog(props: {
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
                title: t('piImport.dialog.title'),
                description: t('piImport.dialog.description'),
                concurrentWarning: t('piImport.dialog.concurrentWarning'),
                loading: t('piImport.loading'),
                empty: t('piImport.empty'),
                selectedCount: t('piImport.selectedCount'),
                clearAll: t('piImport.clearAll'),
                selectAll: t('piImport.selectAll'),
                allDirectories: t('piImport.allDirectories'),
                search: t('piImport.search'),
                imported: t('piImport.imported'),
                needsAttention: t('piImport.needsAttention'),
                messages: t('piImport.messages'),
                importing: t('piImport.importing'),
                confirm: t('piImport.confirm'),
                cancel: t('button.cancel')
            }}
        />
    )
}