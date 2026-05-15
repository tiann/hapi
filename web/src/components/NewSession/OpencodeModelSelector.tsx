import { useTranslation } from '@/lib/use-translation'
import type { OpencodeModelSummary } from '@/types/api'

export type OpencodeModelSelectorProps = {
    cwd: string
    machineId: string | null
    isLoading: boolean
    error: string | null
    availableModels: OpencodeModelSummary[]
    currentModelId: string | null
    selectedModel: string | null
    onModelChange: (modelId: string | null) => void
    onRetry?: () => void
}

export function OpencodeModelSelector(props: OpencodeModelSelectorProps) {
    const { t } = useTranslation()

    if (!props.cwd || !props.machineId) {
        return null
    }

    return (
        <div className="flex flex-col gap-2 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.model')}{' '}
                <span className="font-normal">({t('newSession.model.optional')})</span>
            </label>

            {props.isLoading ? (
                <div className="flex flex-col gap-2" data-testid="opencode-model-loading">
                    <div className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--app-divider)] border-t-[var(--app-link)]" />
                        <span>{t('newSession.opencodeModel.loading')}</span>
                    </div>
                    <div className="flex flex-col gap-1.5" aria-hidden="true">
                        {[0, 1, 2, 3].map((i) => (
                            <div
                                key={i}
                                className="h-7 w-full animate-pulse rounded bg-[var(--app-secondary-bg)]"
                            />
                        ))}
                    </div>
                </div>
            ) : props.error ? (
                <div className="flex flex-col gap-2" data-testid="opencode-model-error">
                    <div className="text-xs text-red-600">
                        {t('newSession.opencodeModel.loadFailed')}: {props.error}
                    </div>
                    {props.onRetry ? (
                        <button
                            type="button"
                            onClick={props.onRetry}
                            className="self-start rounded border border-[var(--app-divider)] px-2 py-1 text-xs text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)]"
                        >
                            {t('newSession.opencodeModel.retry')}
                        </button>
                    ) : null}
                </div>
            ) : props.availableModels.length === 0 ? (
                <div className="text-xs text-[var(--app-hint)]" data-testid="opencode-model-empty">
                    {t('newSession.opencodeModel.empty')}
                </div>
            ) : (
                <div className="flex flex-col" data-testid="opencode-model-list">
                    {props.availableModels.map((model) => {
                        const isSelected = props.selectedModel === model.modelId
                        const isDefault = props.currentModelId === model.modelId
                        return (
                            <button
                                key={model.modelId}
                                type="button"
                                onClick={() => props.onModelChange(model.modelId)}
                                className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition-colors hover:bg-[var(--app-secondary-bg)]"
                            >
                                <div
                                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                                        isSelected
                                            ? 'border-[var(--app-link)]'
                                            : 'border-[var(--app-hint)]'
                                    }`}
                                >
                                    {isSelected && (
                                        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                    )}
                                </div>
                                <span className={`flex-1 truncate ${isSelected ? 'text-[var(--app-link)]' : ''}`}>
                                    {model.name ?? model.modelId}
                                </span>
                                {isDefault ? (
                                    <span className="rounded border border-[var(--app-divider)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--app-hint)]">
                                        {t('newSession.opencodeModel.default')}
                                    </span>
                                ) : null}
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
