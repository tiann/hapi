import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

export const CONTINUE_PROMPT = '同意, 继续'

export function ContinuePromptDialog(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onConfirm: () => void
}) {
    const { t } = useTranslation()

    const handleConfirm = () => {
        props.onConfirm()
        props.onOpenChange(false)
    }

    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('composer.continueShortcut.confirmTitle')}</DialogTitle>
                    <DialogDescription className="mt-2">
                        {t('composer.continueShortcut.confirmDescription')}
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-sm font-medium text-[var(--app-fg)]">
                    {CONTINUE_PROMPT}
                </div>

                <div className="mt-4 flex justify-end gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={() => props.onOpenChange(false)}
                    >
                        {t('button.cancel')}
                    </Button>
                    <Button
                        type="button"
                        onClick={handleConfirm}
                    >
                        {t('composer.continueShortcut.confirmSend')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
