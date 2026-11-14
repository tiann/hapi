import type { LocalSessionListItem } from '@/lib/localSessionImport'
import { useTranslation } from '@/lib/use-translation'
import { LocalSessionImportDialog } from '@/components/LocalSessionImportDialog'

/** Claude-flavored wrapper around the generic import dialog. */
export function ClaudeSessionImportDialog(props: {
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
                title: t('claudeImport.dialog.title'),
                description: t('claudeImport.dialog.description'),
                concurrentWarning: t('claudeImport.dialog.concurrentWarning'),
                loading: t('claudeImport.loading'),
                empty: t('claudeImport.empty'),
                selectedCount: t('claudeImport.selectedCount'),
                clearAll: t('claudeImport.clearAll'),
                selectAll: t('claudeImport.selectAll'),
                allDirectories: t('claudeImport.allDirectories'),
                search: t('claudeImport.search'),
                imported: t('claudeImport.imported'),
                importing: t('claudeImport.importing'),
                confirm: t('claudeImport.confirm'),
                cancel: t('button.cancel')
            }}
        />
    )
}