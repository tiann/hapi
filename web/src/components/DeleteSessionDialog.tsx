import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/lib/use-translation'

type DeleteSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    description: string
    onConfirm: () => Promise<void>
    isPending: boolean
    isArchiving: boolean
}

export function DeleteSessionDialog(props: DeleteSessionDialogProps) {
    const { t } = useTranslation()
    return (
        <ConfirmDialog
            isOpen={props.isOpen}
            onClose={props.onClose}
            title={t('dialog.delete.title')}
            description={props.isArchiving ? t('dialog.delete.waitingForArchiveDescription') : props.description}
            confirmLabel={t(props.isArchiving ? 'dialog.delete.waitingForArchive' : 'dialog.delete.confirm')}
            confirmingLabel={t('dialog.delete.confirming')}
            onConfirm={props.onConfirm}
            isPending={props.isPending && !props.isArchiving}
            isConfirmDisabled={props.isArchiving}
            destructive
            centerTitle
        />
    )
}
