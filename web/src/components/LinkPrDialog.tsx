import { useEffect, useRef, useState } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'
import { buildGithubPrExternalRef, parseGithubPrInput } from '@hapi/protocol'
import type { ExternalRef } from '@/types/api'

type LinkPrDialogProps = {
    isOpen: boolean
    onClose: () => void
    currentPrimaryLabel?: string | null
    onUpsert: (ref: ExternalRef) => Promise<void>
    onRemovePrimary?: () => Promise<void>
    isPending: boolean
}

export function LinkPrDialog(props: LinkPrDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose, currentPrimaryLabel, onUpsert, onRemovePrimary, isPending } = props
    const [input, setInput] = useState('')
    const [error, setError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (isOpen) {
            setInput('')
            setError(null)
            setTimeout(() => inputRef.current?.focus(), 100)
        }
    }, [isOpen])

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault()
        const parsed = parseGithubPrInput(input)
        if (!parsed.ok) {
            setError(parsed.error)
            return
        }
        setError(null)
        try {
            await onUpsert(buildGithubPrExternalRef({
                repo: parsed.repo,
                number: parsed.number,
                role: 'primary',
                source: 'user',
                linkedAt: Date.now()
            }))
            onClose()
        } catch (linkError) {
            setError(linkError instanceof Error ? linkError.message : t('dialog.linkPr.error'))
        }
    }

    const handleUnlink = async () => {
        if (!onRemovePrimary) return
        setError(null)
        try {
            await onRemovePrimary()
            onClose()
        } catch (unlinkError) {
            setError(unlinkError instanceof Error ? unlinkError.message : t('dialog.linkPr.error'))
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('dialog.linkPr.title')}</DialogTitle>
                </DialogHeader>
                <form onSubmit={(event) => void handleSubmit(event)} className="mt-4 flex flex-col gap-4">
                    {currentPrimaryLabel ? (
                        <p className="text-sm text-[var(--app-hint)]">
                            {t('dialog.linkPr.current', { label: currentPrimaryLabel })}
                        </p>
                    ) : null}
                    <input
                        ref={inputRef}
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        placeholder={t('dialog.linkPr.placeholder')}
                        className="w-full px-3 py-2.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent"
                        disabled={isPending}
                    />
                    {error ? (
                        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                            {error}
                        </div>
                    ) : null}
                    <div className="flex gap-2 justify-end">
                        {currentPrimaryLabel && onRemovePrimary ? (
                            <Button
                                type="button"
                                variant="secondary"
                                disabled={isPending}
                                onClick={() => void handleUnlink()}
                            >
                                {t('dialog.linkPr.unlink')}
                            </Button>
                        ) : null}
                        <Button type="button" variant="secondary" onClick={onClose} disabled={isPending}>
                            {t('button.cancel')}
                        </Button>
                        <Button type="submit" disabled={isPending || !input.trim()}>
                            {isPending ? t('dialog.linkPr.linking') : t('dialog.linkPr.link')}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    )
}
