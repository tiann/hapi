import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'

type ArchiveSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    sessionId: string
    sessionName: string
    active: boolean
    onConfirm: () => Promise<void>
    isPending: boolean
}

export function ArchiveSessionDialog(props: ArchiveSessionDialogProps) {
    const { t } = useTranslation()
    const { addToast } = useToast()
    // Inactive SSE can arrive before the archive request has finished its
    // process checks. It is progress, not proof that cleanup succeeded.
    const confirmingCleanup = props.isPending && !props.active
    return (
        <ConfirmDialog
            isOpen={props.isOpen}
            onClose={props.onClose}
            title={t('dialog.archive.title')}
            description={confirmingCleanup
                ? t('dialog.archive.cleanupDescription')
                : props.isPending
                    ? t('dialog.archive.pendingDescription')
                    : t('dialog.archive.description', { name: props.sessionName })}
            confirmLabel={t('dialog.archive.confirm')}
            confirmingLabel={t(confirmingCleanup ? 'dialog.archive.cleaning' : 'dialog.archive.confirming')}
            onConfirm={props.onConfirm}
            isPending={props.isPending}
            allowDismissWhilePending
            onBackgroundError={(message) => addToast({
                title: t('dialog.archive.error'), body: message,
                sessionId: props.sessionId, url: `/sessions/${props.sessionId}`
            })}
            destructive
            centerTitle
        />
    )
}
