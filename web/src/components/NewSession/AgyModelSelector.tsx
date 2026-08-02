import { useTranslation } from '@/lib/use-translation'
import type { AgyModelSummary } from '@/types/api'

export type AgyModelSelectorProps = {
    machineId: string | null
    isLoading: boolean
    error: string | null
    availableModels: AgyModelSummary[]
    selectedModel: string | null
    onModelChange: (modelId: string | null) => void
    onRetry?: () => void
}

export function AgyModelSelector(props: AgyModelSelectorProps) {
    const { t } = useTranslation()

    if (!props.machineId) {
        return null
    }

    return (
        <div className="flex flex-col gap-2 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.model')}{' '}
                <span className="font-normal">({t('newSession.model.optional')})</span>
            </label>

            {props.isLoading ? (
                <div className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--app-divider)] border-t-[var(--app-link)]" />
                    <span>{t('newSession.agyModel.checkingAuth')}</span>
                </div>
            ) : props.error ? (
                <div className="flex flex-col gap-2" data-testid="agy-model-auth-error">
                    <div className="text-xs text-red-600">
                        {t('newSession.agyModel.authRequired')}: {props.error}
                    </div>
                    <div className="text-xs text-[var(--app-hint)]">
                        {t('newSession.agyModel.authHint')}
                    </div>
                    {props.onRetry ? (
                        <button
                            type="button"
                            onClick={props.onRetry}
                            className="self-start rounded border border-[var(--app-divider)] px-2 py-1 text-xs text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)]"
                        >
                            {t('newSession.agyModel.retry')}
                        </button>
                    ) : null}
                </div>
            ) : props.availableModels.length === 0 ? (
                <div className="text-xs text-[var(--app-hint)]">
                    {t('newSession.agyModel.noModels')}
                </div>
            ) : (
                <select
                    data-testid="agy-model-list"
                    value={props.selectedModel ?? ''}
                    onChange={(e) => props.onModelChange(e.target.value || null)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                >
                    <option value="">{t('newSession.model.default')}</option>
                    {props.availableModels.map((model) => (
                        <option key={model.modelId} value={model.modelId}>
                            {model.name ?? model.modelId}
                        </option>
                    ))}
                </select>
            )}
        </div>
    )
}
