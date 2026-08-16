import { useTranslation } from '@/lib/use-translation'
import type { OpencodeModelSummary } from '@/types/api'
import { SelectControl } from '@/components/ui/select-control'

export type OpencodeModelSelectorProps = {
    cwd: string
    machineId: string | null
    isLoading: boolean
    error: string | null
    availableModels: OpencodeModelSummary[]
    currentModelId: string | null
    selectedModel: string | null | undefined
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
                <SelectControl
                    data-testid="opencode-model-list"
                    value={props.selectedModel ?? ''}
                    onChange={(event) => props.onModelChange(event.target.value || null)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                >
                    <option value="">{t('newSession.model.default')}</option>
                    {props.availableModels.map((model) => (
                        <option key={model.modelId} value={model.modelId}>
                            {model.name ?? model.modelId}{props.currentModelId === model.modelId ? ` (${t('newSession.opencodeModel.default')})` : ''}
                        </option>
                    ))}
                </SelectControl>
            )}
        </div>
    )
}
