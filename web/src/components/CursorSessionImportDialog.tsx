import type { LocalSessionListItem } from '@/lib/localSessionImport'
import { useTranslation } from '@/lib/use-translation'
import { LocalSessionImportDialog } from '@/components/LocalSessionImportDialog'

/** Cursor-flavored wrapper around the generic import dialog. */
export function CursorSessionImportDialog(props: {
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
                title: t('cursorImport.dialog.title'),
                description: t('cursorImport.dialog.description'),
                concurrentWarning: t('cursorImport.dialog.concurrentWarning'),
                loading: t('cursorImport.loading'),
                empty: t('cursorImport.empty'),
                selectedCount: t('cursorImport.selectedCount'),
                clearAll: t('cursorImport.clearAll'),
                selectAll: t('cursorImport.selectAll'),
                allDirectories: t('cursorImport.allDirectories'),
                search: t('cursorImport.search'),
                imported: t('cursorImport.imported'),
                importing: t('cursorImport.importing'),
                confirm: t('cursorImport.confirm'),
                cancel: t('button.cancel')
            }}
        />
    )
}
