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

type ArchiveSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    sessionName: string
    onArchive: () => Promise<void>
    isPending: boolean
}

export function ArchiveSessionDialog(props: ArchiveSessionDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose, sessionName, onArchive, isPending } = props
    const archiveButtonRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (isOpen) {
            setTimeout(() => {
                archiveButtonRef.current?.focus()
            }, 100)
        }
    }, [isOpen])

    const handleArchive = async () => {
        await onArchive()
        onClose()
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('dialog.archive.title')}</DialogTitle>
                    <DialogDescription>
                        {t('dialog.archive.description')} &quot;{sessionName}&quot;
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
                        ref={archiveButtonRef}
                        type="button"
                        onClick={handleArchive}
                        disabled={isPending}
                    >
                        {isPending ? t('dialog.archive.archiving') : t('dialog.archive.confirm')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
