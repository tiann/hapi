import { useEffect, useRef, useState } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { getApiErrorMessage } from '@/lib/apiErrorMessage'
import { useTranslation } from '@/lib/use-translation'

type AddBoardDialogProps = {
    isOpen: boolean
    onClose: () => void
    onAdd: (url: string) => Promise<void>
}

export function AddBoardDialog(props: AddBoardDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose, onAdd } = props
    const [url, setUrl] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (!isOpen) return
        setUrl('')
        setError(null)
        setIsSubmitting(false)
        setTimeout(() => inputRef.current?.focus(), 100)
    }, [isOpen])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        const trimmed = url.trim()
        if (!trimmed) return
        setError(null)
        setIsSubmitting(true)
        try {
            await onAdd(trimmed)
            onClose()
        } catch (err) {
            setError(getApiErrorMessage(err, t('boards.addBoard.error')))
        } finally {
            setIsSubmitting(false)
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && !isSubmitting && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader className="pr-0">
                    <DialogTitle className="min-h-6 px-10 text-center leading-6">
                        {t('boards.addBoard.title')}
                    </DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
                    <input
                        ref={inputRef}
                        type="text"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder={t('boards.addBoard.placeholder')}
                        className="w-full px-3 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent"
                        disabled={isSubmitting}
                    />

                    {error ? (
                        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                            {error}
                        </div>
                    ) : null}

                    <div className="flex items-center justify-end gap-2">
                        <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
                            {t('button.cancel')}
                        </Button>
                        <Button type="submit" disabled={isSubmitting || !url.trim()}>
                            {isSubmitting ? t('boards.addBoard.adding') : t('boards.addBoard.submit')}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}
