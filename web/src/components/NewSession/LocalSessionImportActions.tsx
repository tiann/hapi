import type { LocalSessionListItem } from '@/lib/localSessionImport'

export type LocalSessionImportActionLabels = {
    inlineTitle: string
    inlineDescription: string
    inlineClear: string
    inlineChoose: string
    loading: string
}

/** Inline New Session strip for choosing a local session to import/continue. */
export function LocalSessionImportActions(props: {
    labels: LocalSessionImportActionLabels
    selectedSession: LocalSessionListItem | null
    isLoading: boolean
    isDisabled: boolean
    error: string | null
    onChooseHistory: () => void
    onClear: () => void
}) {
    return (
        <div className="flex flex-col gap-2 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                    <div className="text-xs font-medium text-[var(--app-hint)]">{props.labels.inlineTitle}</div>
                    <div className="truncate text-[11px] text-[var(--app-hint)]">
                        {props.selectedSession ? props.selectedSession.title : props.labels.inlineDescription}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {props.selectedSession ? (
                        <button type="button" className="text-xs text-[var(--app-link)]" onClick={props.onClear} disabled={props.isDisabled}>
                            {props.labels.inlineClear}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1.5 text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-50"
                        onClick={props.onChooseHistory}
                        disabled={props.isDisabled || props.isLoading}
                    >
                        {props.isLoading ? props.labels.loading : props.labels.inlineChoose}
                    </button>
                </div>
            </div>
            {props.error ? <div className="text-xs text-red-600">{props.error}</div> : null}
        </div>
    )
}