import { useRef, useEffect } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription
} from '@/shared/ui/dialog'
import { Button } from '@/shared/ui/button'
import { useTranslation } from '@/lib/use-translation'

type DeleteSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    sessionName: string
    onDelete: () => Promise<void>
    isPending: boolean
}

export function DeleteSessionDialog(props: DeleteSessionDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose, sessionName, onDelete, isPending } = props
    const deleteButtonRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (isOpen) {
            setTimeout(() => {
                deleteButtonRef.current?.focus()
            }, 100)
        }
    }, [isOpen])

    const handleDelete = async () => {
        await onDelete()
        onClose()
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('dialog.delete.title')}</DialogTitle>
                    <DialogDescription>
                        {t('dialog.delete.description')} &quot;{sessionName}&quot;
                    </DialogDescription>
                </DialogHeader>
                <div className="mt-4 flex gap-2 justify-end">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={isPending}
                    >
                        {t('button.cancel')}
                    </Button>
                    <Button
                        ref={deleteButtonRef}
                        type="button"
                        variant="destructive"
                        onClick={handleDelete}
                        disabled={isPending}
                    >
                        {isPending ? t('dialog.delete.deleting') : t('dialog.delete.confirm')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
