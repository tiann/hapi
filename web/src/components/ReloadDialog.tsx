import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

type ReloadDialogProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    onConfirm: (force: boolean, enableYolo: boolean) => void
    currentYoloState: boolean
    isBusy: boolean
}

export function ReloadDialog({ open, onOpenChange, onConfirm, currentYoloState, isBusy }: ReloadDialogProps) {
    const { t } = useTranslation()
    const [enableYolo, setEnableYolo] = useState(currentYoloState)
    const [force, setForce] = useState(false)

    const handleConfirm = () => {
        onConfirm(force, enableYolo)
        onOpenChange(false)
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[calc(100vw-24px)] max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('dialog.reload.title')}</DialogTitle>
                    <DialogDescription>{t('dialog.reload.description')}</DialogDescription>
                </DialogHeader>

                <div className="space-y-3 py-4">
                    {isBusy && (
                        <button
                            type="button"
                            onClick={() => setForce(!force)}
                            className="w-full flex items-start gap-3 p-3 rounded-lg border border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)] transition-colors text-left"
                        >
                            <span className="text-base select-none mt-0.5" aria-hidden="true">
                                {force ? '☑' : '☐'}
                            </span>
                            <div className="flex-1">
                                <div className="text-sm font-medium text-[var(--app-fg)]">
                                    {t('dialog.reload.forceLabel')}
                                </div>
                                <div className="text-xs text-[var(--app-hint)] mt-1">
                                    {t('dialog.reload.forceDescription')}
                                </div>
                            </div>
                        </button>
                    )}

                    <button
                        type="button"
                        onClick={() => setEnableYolo(!enableYolo)}
                        className="w-full flex items-start gap-3 p-3 rounded-lg border border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)] transition-colors text-left"
                    >
                        <span className="text-base select-none mt-0.5" aria-hidden="true">
                            {enableYolo ? '☑' : '☐'}
                        </span>
                        <div className="flex-1">
                            <div className="text-sm font-medium text-[var(--app-fg)]">
                                {t('dialog.reload.yoloLabel')}
                            </div>
                            <div className="text-xs text-[var(--app-hint)] mt-1">
                                {t('dialog.reload.yoloDescription')}
                            </div>
                        </div>
                    </button>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        {t('dialog.cancel')}
                    </Button>
                    <Button onClick={handleConfirm}>
                        {t('dialog.reload.confirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
