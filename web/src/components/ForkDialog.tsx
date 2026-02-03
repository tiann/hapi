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

type ForkDialogProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    onConfirm: (enableYolo: boolean) => void
    currentYoloState: boolean
}

export function ForkDialog({ open, onOpenChange, onConfirm, currentYoloState }: ForkDialogProps) {
    const { t } = useTranslation()
    const [enableYolo, setEnableYolo] = useState(currentYoloState)

    const handleConfirm = () => {
        onConfirm(enableYolo)
        onOpenChange(false)
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[calc(100vw-24px)] max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('dialog.fork.title')}</DialogTitle>
                    <DialogDescription>{t('dialog.fork.description')}</DialogDescription>
                </DialogHeader>

                <div className="py-4">
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
                                {t('dialog.fork.yoloLabel')}
                            </div>
                            <div className="text-xs text-[var(--app-hint)] mt-1">
                                {t('dialog.fork.yoloDescription')}
                            </div>
                        </div>
                    </button>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        {t('dialog.cancel')}
                    </Button>
                    <Button onClick={handleConfirm}>
                        {t('dialog.fork.confirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
