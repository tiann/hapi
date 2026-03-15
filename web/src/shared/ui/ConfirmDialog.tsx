import { useState, useEffect } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription
} from '@/shared/ui/dialog'
import { Button } from '@/shared/ui/button'

type ConfirmDialogProps = {
    isOpen: boolean
    onClose: () => void
    title: string
    description: string
    confirmLabel: string
    confirmingLabel: string
    cancelLabel: string
    defaultErrorMessage: string
    onConfirm: () => Promise<void>
    isPending: boolean
    destructive?: boolean
}

export function ConfirmDialog(props: ConfirmDialogProps) {
    const {
        isOpen,
        onClose,
        title,
        description,
        confirmLabel,
        confirmingLabel,
        cancelLabel,
        defaultErrorMessage,
        onConfirm,
        isPending,
        destructive = false
    } = props

    const [error, setError] = useState<string | null>(null)

    // Clear error when dialog opens/closes
    useEffect(() => {
        if (isOpen) {
            setError(null)
        }
    }, [isOpen])

    const handleConfirm = async () => {
        setError(null)
        try {
            await onConfirm()
            onClose()
        } catch (err) {
            const message =
                err instanceof Error && err.message
                    ? err.message
                    : defaultErrorMessage
            setError(message)
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
                    <div className="mt-3 rounded-md bg-[var(--app-badge-error-bg)] p-3 text-sm text-[var(--app-badge-error-text)]">
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
                        {cancelLabel}
                    </Button>
                    <Button
                        type="button"
                        variant={destructive ? 'destructive' : 'secondary'}
                        onClick={handleConfirm}
                        disabled={isPending}
                    >
                        {isPending ? confirmingLabel : confirmLabel}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
