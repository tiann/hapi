import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'
import type { ForkPreviewKind, ForkPreviewTurn } from '@/lib/forkPreview'

type ForkPreviewDialogProps = {
    isOpen: boolean
    kind: ForkPreviewKind
    keptTurns: ForkPreviewTurn[]
    boundaryText: string | null
    /** True when older messages exist beyond the loaded window, so an empty
     * prefix does not mean the child starts empty. */
    prefixMayHaveMore?: boolean
    onCancel: () => void
    onConfirm: () => Promise<void>
}

export function ForkPreviewDialog({ isOpen, kind, keptTurns, boundaryText, prefixMayHaveMore = false, onCancel, onConfirm }: ForkPreviewDialogProps) {
    const { t } = useTranslation()
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const handleConfirm = async () => {
        setError(null)
        setPending(true)
        try {
            await onConfirm()
        } catch (err) {
            setError(err instanceof Error && err.message ? err.message : t('dialog.error.default'))
        } finally {
            setPending(false)
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !pending) onCancel() }}>
            <DialogContent aria-describedby={undefined} className="flex max-h-[85vh] flex-col gap-3">
                <DialogHeader>
                    <DialogTitle>{t('forkPreview.title')}</DialogTitle>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--app-subtle-bg)] p-3" data-testid="fork-preview-thread">
                    {keptTurns.length > 0 ? (
                        <div className="flex flex-col gap-2">
                            {keptTurns.map((turn, index) => (
                                <div key={index} className={turn.role === 'user' ? 'self-end rounded-xl bg-[var(--app-subtle-bg)] px-3 py-2 text-sm' : 'self-start text-sm'}>
                                    <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-[var(--app-hint)]">
                                        {t(turn.role === 'user' ? 'forkPreview.roleUser' : 'forkPreview.roleAssistant')}
                                    </span>
                                    <span className="line-clamp-3">{turn.text}</span>
                                </div>
                            ))}
                            <div className="text-center text-[10px] text-[var(--app-hint)]">
                                {t('forkPreview.keptAbove')}
                            </div>
                            {prefixMayHaveMore ? (
                                <div className="text-center text-xs text-[var(--app-hint)]">
                                    {t('forkPreview.noTextPreview')}
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <div className="text-center text-xs text-[var(--app-hint)]">
                            {t(prefixMayHaveMore ? 'forkPreview.noTextPreview' : 'forkPreview.emptyPrefix')}
                        </div>
                    )}
                    {kind === 'historical' ? (
                        <>
                            <div className="my-3 flex items-center gap-2" data-testid="fork-preview-boundary">
                                <span className="h-px flex-1 bg-[var(--app-link)]" />
                                <span className="rounded-full bg-[var(--app-link)] px-2 py-0.5 text-[10px] font-medium text-[var(--app-bg)]">
                                    {t('forkPreview.boundaryBadge')}
                                </span>
                                <span className="h-px flex-1 bg-[var(--app-link)]" />
                            </div>
                            {boundaryText ? (
                                <div className="rounded-xl border-2 border-dashed border-[var(--app-link)] px-3 py-2 text-sm" data-testid="fork-preview-boundary-message">
                                    <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-[var(--app-link)]">
                                        {t('forkPreview.newSessionStart')}
                                    </span>
                                    <span className="line-clamp-2">{boundaryText}</span>
                                </div>
                            ) : null}
                        </>
                    ) : null}
                </div>
                <p className="text-xs text-[var(--app-hint)]">
                    {t(kind === 'historical' ? 'forkPreview.below' : 'forkPreview.currentTail')}
                </p>
                {error ? (
                    <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400" data-testid="fork-preview-error">
                        {error}
                    </div>
                ) : null}
                <div className={`flex gap-2 ${pending ? 'opacity-60' : ''}`}>
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={pending}
                        className="flex-1 rounded-lg border border-[var(--app-subtle-bg)] px-3 py-2 text-sm hover:bg-[var(--app-subtle-bg)]"
                    >
                        {t('forkPreview.cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={() => { void handleConfirm() }}
                        disabled={pending}
                        data-testid="fork-preview-confirm"
                        className="flex-1 rounded-lg bg-[var(--app-link)] px-3 py-2 text-sm font-medium text-[var(--app-bg)] hover:opacity-90"
                    >
                        {t('forkPreview.confirm')}
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
