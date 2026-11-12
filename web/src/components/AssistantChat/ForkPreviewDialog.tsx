import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'
import type { ForkPreviewView } from '@/lib/forkPreview'

type ForkPreviewDialogProps = {
    isOpen: boolean
    view: ForkPreviewView
    /** True when older messages exist beyond the loaded window, so an empty
     * prefix does not mean the child starts empty. */
    prefixMayHaveMore?: boolean
    /** The source moved since the preview was taken; the hub refreshed it. */
    stale?: boolean
    onCancel: () => void
    onConfirm: () => Promise<void>
}

/**
 * Confirmation dialog fed by the hub fork-preview answer: kept rows above the
 * fork point, the excluded boundary message below it, and — for rewind — the
 * deleted region with destructive emphasis.
 */
export function ForkPreviewDialog({ isOpen, view, prefixMayHaveMore = false, stale = false, onCancel, onConfirm }: ForkPreviewDialogProps) {
    const { t } = useTranslation()
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const rewind = view.kind === 'rewind'

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
                    <DialogTitle>{t(rewind ? 'forkPreview.rewindTitle' : 'forkPreview.title')}</DialogTitle>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--app-subtle-bg)] p-3" data-testid="fork-preview-thread">
                    {view.keptTurns.length > 0 ? (
                        <div className="flex flex-col gap-2">
                            {view.keptTurns.map((turn, index) => (
                                <div key={index} className={turn.role === 'user' ? 'self-end rounded-xl bg-[var(--app-subtle-bg)] px-3 py-2 text-sm' : 'self-start text-sm'}>
                                    <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-[var(--app-hint)]">
                                        {t(turn.role === 'user' ? 'forkPreview.roleUser' : 'forkPreview.roleAssistant')}
                                    </span>
                                    <span className="line-clamp-3">{turn.text}</span>
                                </div>
                            ))}
                            <div className="text-center text-[10px] text-[var(--app-hint)]">
                                {t(rewind ? 'forkPreview.keptStays' : 'forkPreview.keptAbove')}
                            </div>
                            {prefixMayHaveMore ? (
                                <div className="text-center text-xs text-[var(--app-hint)]">
                                    {t('forkPreview.noTextPreview')}
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <div className="text-center text-xs text-[var(--app-hint)]">
                            {t(prefixMayHaveMore ? 'forkPreview.noTextPreview' : rewind ? 'forkPreview.rewindEmptyPrefix' : 'forkPreview.emptyPrefix')}
                        </div>
                    )}
                    {view.kind !== 'current' ? (
                        <>
                            <div className="my-3 flex items-center gap-2" data-testid="fork-preview-boundary">
                                <span className="h-px flex-1 bg-[var(--app-link)]" />
                                <span className="rounded-full bg-[var(--app-link)] px-2 py-0.5 text-[10px] font-medium text-[var(--app-bg)]">
                                    {t(rewind ? 'forkPreview.rewindBoundaryBadge' : 'forkPreview.boundaryBadge')}
                                </span>
                                <span className="h-px flex-1 bg-[var(--app-link)]" />
                            </div>
                            {view.boundaryText ? (
                                <div className={`rounded-xl border-2 border-dashed px-3 py-2 text-sm ${rewind ? 'border-red-400 dark:border-red-700' : 'border-[var(--app-link)]'}`} data-testid="fork-preview-boundary-message">
                                    <span className={`mb-0.5 block text-[10px] uppercase tracking-wide ${rewind ? 'text-red-600 dark:text-red-400' : 'text-[var(--app-link)]'}`}>
                                        {t(rewind ? 'forkPreview.rewindSessionStart' : 'forkPreview.newSessionStart')}
                                    </span>
                                    <span className="line-clamp-2">{view.boundaryText}</span>
                                </div>
                            ) : null}
                            {rewind && view.excludedTurns.length > 0 ? (
                                <div className="mt-2 flex flex-col gap-2" data-testid="fork-preview-excluded">
                                    {view.excludedTurns.map((turn, index) => (
                                        <div key={index} className={turn.role === 'user' ? 'self-end rounded-xl border border-red-300 px-3 py-2 text-sm opacity-70 dark:border-red-800' : 'self-start text-sm line-through opacity-50'}>
                                            <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-red-600 dark:text-red-400">
                                                {t(turn.role === 'user' ? 'forkPreview.roleUser' : 'forkPreview.roleAssistant')}
                                            </span>
                                            <span className="line-clamp-3">{turn.text}</span>
                                        </div>
                                    ))}
                                    {view.excludedTruncated ? (
                                        <div className="text-center text-[10px] text-red-600 dark:text-red-400">
                                            {t('forkPreview.excludedTruncated', { n: view.excludedHidden })}
                                        </div>
                                    ) : (
                                        <div className="text-center text-[10px] text-red-600 dark:text-red-400">
                                            {t('forkPreview.deletedBelow')}
                                        </div>
                                    )}
                                </div>
                            ) : null}
                        </>
                    ) : null}
                </div>
                <p className="text-xs text-[var(--app-hint)]">
                    {t(rewind ? 'forkPreview.rewindBelow'
                        : view.kind === 'message' ? 'forkPreview.below'
                        : view.kind === 'latestCompleted' ? 'forkPreview.latestCompletedTail' : 'forkPreview.currentTail')}
                </p>
                {stale ? (
                    <div className="rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm" data-testid="fork-preview-stale">
                        {t('forkPreview.staleNotice')}
                    </div>
                ) : null}
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
                        className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium hover:opacity-90 ${rewind ? 'bg-red-600 text-white' : 'bg-[var(--app-link)] text-[var(--app-bg)]'}`}
                    >
                        {t(rewind ? 'forkPreview.rewindConfirm' : 'forkPreview.confirm')}
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    )
}