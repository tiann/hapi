import { useState } from 'react'
import { useTranslation } from '@/lib/use-translation'

// Minimal shape that both Metadata and SessionSummaryMetadata satisfy
export type ModelErrorHolder = {
    lastModelError?: {
        kind: string
        transient: boolean
        rawSnippet: string
        atTs: number
        priorAssistantClaimsDone: boolean
        retriedAndFailed?: boolean
        acknowledgedAt?: number
    }
    [key: string]: unknown
}

export function hasActiveModelError(metadata: ModelErrorHolder | null | undefined): boolean {
    if (!metadata?.lastModelError) return false
    return !metadata.lastModelError.acknowledgedAt
}

export function ModelErrorBanner({
    metadata,
    onDismiss
}: {
    metadata: ModelErrorHolder | null | undefined
    onDismiss: () => void
}) {
    const { t } = useTranslation()
    const [showRaw, setShowRaw] = useState(false)

    const err = metadata?.lastModelError
    if (!err || err.acknowledgedAt) {
        return null
    }

    const transientLabel = err.transient
        ? t('session.modelError.banner.subtitle.transient')
        : t('session.modelError.banner.subtitle.nonTransient')

    const title = t('session.modelError.banner.title', { kind: err.kind })

    const bodyText = err.priorAssistantClaimsDone
        ? t('session.modelError.banner.claimedDone')
        : t('session.modelError.banner.midExecution')

    return (
        <div className="px-3 pt-3" data-testid="model-error-banner">
            <div
                role="alert"
                aria-live="assertive"
                className="mx-auto flex w-full max-w-content flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-[var(--app-text)]"
            >
                <div className="flex items-start gap-2">
                    <span aria-hidden="true" className="mt-0.5 shrink-0 text-amber-500">
                        &#9888;
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="font-semibold text-amber-600 dark:text-amber-400">
                            {title}{' '}
                            <span className="text-xs font-normal opacity-70">
                                ({transientLabel})
                            </span>
                        </div>
                        <div className="mt-0.5 text-xs text-[var(--app-hint)]">
                            {bodyText}
                        </div>
                        {showRaw && (
                            <pre className="mt-2 max-h-24 overflow-auto rounded bg-black/10 p-2 text-xs font-mono whitespace-pre-wrap break-all dark:bg-white/5">
                                {err.rawSnippet}
                            </pre>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2 pl-6">
                    <button
                        type="button"
                        onClick={onDismiss}
                        className="rounded px-2 py-0.5 text-xs font-medium border border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                    >
                        {t('session.modelError.banner.dismiss')}
                    </button>
                    <button
                        type="button"
                        onClick={() => setShowRaw((v) => !v)}
                        className="rounded px-2 py-0.5 text-xs font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
                    >
                        {t('session.modelError.banner.viewRaw')}
                    </button>
                </div>
            </div>
        </div>
    )
}
