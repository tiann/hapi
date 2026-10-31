import { useIsMutating } from '@tanstack/react-query'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { sessionArchiveMutationKey } from '@/hooks/mutations/useSessionActions'
import { useTranslation } from '@/lib/use-translation'

type DeleteSessionDialogProps = {
    isOpen: boolean
    sessionId: string
    onClose: () => void
    description: string
    onConfirm: () => Promise<void>
    isPending: boolean
}

export function DeleteSessionDialog(props: DeleteSessionDialogProps) {
    // Closed dialogs (including the header's always-mounted wrapper) must not
    // subscribe to every mutation-cache notification across the session list.
    return props.isOpen ? <OpenDeleteSessionDialog key={props.sessionId} {...props} /> : null
}

function OpenDeleteSessionDialog(props: DeleteSessionDialogProps) {
    const { t } = useTranslation()
    // A row may remount, or the archive may originate in another view. Observe
    // shared progress only while this dialog needs to gate deletion.
    const isArchiving = useIsMutating({ mutationKey: sessionArchiveMutationKey(props.sessionId), exact: true }) > 0
    return (
        <ConfirmDialog
            isOpen={props.isOpen}
            onClose={props.onClose}
            title={t('dialog.delete.title')}
            description={isArchiving ? t('dialog.delete.waitingForArchiveDescription') : props.description}
            confirmLabel={t(isArchiving ? 'dialog.delete.waitingForArchive' : 'dialog.delete.confirm')}
            confirmingLabel={t('dialog.delete.confirming')}
            onConfirm={props.onConfirm}
            isPending={props.isPending && !isArchiving}
            isConfirmDisabled={isArchiving}
            destructive
            centerTitle
        />
    )
}
