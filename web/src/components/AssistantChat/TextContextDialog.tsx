import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { countTextLines } from '@/lib/textContext'
import { useTranslation } from '@/lib/use-translation'

export function TextContextDialog(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onAdd: (text: string, name: string) => Promise<void>
}) {
    const { t } = useTranslation()
    const [text, setText] = useState('')
    const [name, setName] = useState('')
    const [isAdding, setIsAdding] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (props.open) {
            setError(null)
        }
    }, [props.open])

    const handleClose = () => {
        if (isAdding) return
        props.onOpenChange(false)
    }

    const handleAdd = async () => {
        if (text.trim().length === 0 || isAdding) return
        setIsAdding(true)
        setError(null)
        try {
            await props.onAdd(text, name)
            setText('')
            setName('')
            props.onOpenChange(false)
        } catch (error) {
            setError(error instanceof Error ? error.message : t('composer.textContext.addFailed'))
        } finally {
            setIsAdding(false)
        }
    }

    return (
        <Dialog open={props.open} onOpenChange={(open) => !open && handleClose()}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t('composer.textContext.title')}</DialogTitle>
                    <DialogDescription>
                        {t('composer.textContext.description')}
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-4 space-y-3">
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium text-[var(--app-fg)]">
                            {t('composer.textContext.name')}
                        </span>
                        <input
                            type="text"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t('composer.textContext.namePlaceholder')}
                            disabled={isAdding}
                            className="h-10 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
                        />
                    </label>

                    <label className="block">
                        <span className="mb-1 block text-sm font-medium text-[var(--app-fg)]">
                            {t('composer.textContext.content')}
                        </span>
                        <textarea
                            autoFocus
                            value={text}
                            onChange={(event) => setText(event.target.value)}
                            placeholder={t('composer.textContext.placeholder')}
                            disabled={isAdding}
                            className="min-h-56 max-h-[55vh] w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-base leading-6 text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
                        />
                    </label>

                    <div className="flex items-center justify-between gap-3 text-xs text-[var(--app-hint)]">
                        <span>
                            {t('composer.textContext.stats', {
                                characters: text.length,
                                lines: countTextLines(text),
                            })}
                        </span>
                        {error ? <span role="alert" className="text-red-600">{error}</span> : null}
                    </div>
                </div>

                <div className="mt-4 flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={handleClose} disabled={isAdding}>
                        {t('button.cancel')}
                    </Button>
                    <Button
                        type="button"
                        onClick={() => { void handleAdd() }}
                        disabled={text.trim().length === 0 || isAdding}
                    >
                        {isAdding
                            ? t('composer.textContext.adding')
                            : t('composer.textContext.add')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
