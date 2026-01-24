import { useState, useEffect } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

type ConfirmDialogProps = {
    isOpen: boolean
    onClose: () => void
    title: string
    description: string
    confirmLabel: string
    confirmingLabel: string
    onConfirm: () => Promise<void>
    isPending: boolean
    destructive?: boolean
    error?: string | null
    onRetry?: () => void
    retryLabel?: string
}

export function ConfirmDialog(props: ConfirmDialogProps) {
    const { t } = useTranslation()
    const {
        isOpen,
        onClose,
        title,
        description,
        confirmLabel,
        confirmingLabel,
        onConfirm,
        isPending,
        destructive = false,
        error: externalError,
        onRetry,
        retryLabel
    } = props

    const [internalError, setInternalError] = useState<string | null>(null)

    // Use external error if provided, otherwise use internal error
    const error = externalError ?? internalError

    // Clear internal error when dialog opens/closes
    useEffect(() => {
        if (isOpen) {
            setInternalError(null)
        }
    }, [isOpen])

    const handleConfirm = async () => {
        setInternalError(null)
        try {
            await onConfirm()
            if (!externalError) {
                onClose()
            }
        } catch (err) {
            const message =
                err instanceof Error && err.message
                    ? err.message
                    : t('dialog.error.default')
            setInternalError(message)
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription className="mt-2">
                        {description}
                    </DialogDescription>
                </DialogHeader>

                {error ? (
                    <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                        {error}
                    </div>
                ) : null}

                <div className="mt-4 flex gap-2 justify-end">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={isPending}
                    >
                        {t('button.cancel')}
                    </Button>
                    {error && onRetry ? (
                        <Button
                            type="button"
                            variant={destructive ? 'destructive' : 'secondary'}
                            onClick={onRetry}
                            disabled={isPending}
                        >
                            {retryLabel || t('button.retry')}
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            variant={destructive ? 'destructive' : 'secondary'}
                            onClick={handleConfirm}
                            disabled={isPending}
                        >
                            {isPending ? confirmingLabel : confirmLabel}
                        </Button>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}
