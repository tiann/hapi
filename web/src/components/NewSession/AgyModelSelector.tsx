import { getAgyModelLabel } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import type { AgyModelSummary } from '@/types/api'

export type AgyModelSelectorProps = {
    machineId: string | null
    isLoading: boolean
    error: string | null
    /** Catalog is usable, but the machine's last sign-in check failed. */
    warning?: string | null
    /** A probe is in flight — asking the machine again can take a while. */
    isFetching?: boolean
    availableModels: AgyModelSummary[]
    selectedModel: string | null
    onModelChange: (modelId: string | null) => void
    onRetry?: () => void
}

/** The catalog can change under an open form, so a model the user already picked
 *  stays listed rather than the select falling blank — labelled, because starting
 *  a session on it is their call but agy is no longer offering it.
 *
 *  `withCurrentModelOption` in AssistantChat/modelOptions.ts leaves the
 *  equivalent entry unlabelled on purpose: there it is the model the session is
 *  already running, a fact rather than a choice about to be made. */
function withSelectedModel(
    models: AgyModelSummary[],
    selectedModel: string | null,
    notListedSuffix: string
): AgyModelSummary[] {
    if (!selectedModel || models.some((model) => model.modelId === selectedModel)) {
        return models
    }
    const label = getAgyModelLabel(selectedModel) ?? selectedModel
    return [{ modelId: selectedModel, name: `${label} (${notListedSuffix})` }, ...models]
}

/** Asks the machine to skip its cached catalog. It says so while it runs, because
 *  the probe is an agy invocation and a click can take tens of seconds. */
function RetryButton(props: { onRetry?: () => void; isFetching?: boolean }) {
    const { t } = useTranslation()

    if (!props.onRetry) {
        return null
    }

    return (
        <button
            type="button"
            onClick={props.onRetry}
            disabled={props.isFetching}
            className="self-start rounded border border-[var(--app-divider)] px-2 py-1 text-xs text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)] disabled:opacity-50"
        >
            {props.isFetching
                ? t('newSession.agyModel.fetchingModels')
                : t('newSession.agyModel.retry')}
        </button>
    )
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
                    <span>{t('newSession.agyModel.fetchingModels')}</span>
                </div>
            ) : props.error ? (
                <div className="flex flex-col gap-2" data-testid="agy-model-auth-error">
                    <div className="text-xs text-red-600">
                        {t('newSession.agyModel.authRequired')}: {props.error}
                    </div>
                    <div className="text-xs text-[var(--app-hint)]">
                        {t('newSession.agyModel.authHint')}
                    </div>
                    <RetryButton onRetry={props.onRetry} isFetching={props.isFetching} />
                </div>
            ) : props.availableModels.length === 0 ? (
                <div className="text-xs text-[var(--app-hint)]">
                    {t('newSession.agyModel.noModels')}
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {props.warning ? (
                        <div className="flex flex-col gap-1" data-testid="agy-model-stale-warning">
                            <div className="text-xs text-amber-600">
                                {t('newSession.agyModel.authRequired')}: {props.warning}
                            </div>
                            <div className="text-xs text-[var(--app-hint)]">
                                {t('newSession.agyModel.authHint')}
                            </div>
                            <RetryButton onRetry={props.onRetry} isFetching={props.isFetching} />
                        </div>
                    ) : null}
                    <select
                        data-testid="agy-model-list"
                        value={props.selectedModel ?? ''}
                        onChange={(e) => props.onModelChange(e.target.value || null)}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                    >
                        <option value="">{t('newSession.model.default')}</option>
                        {withSelectedModel(
                            props.availableModels,
                            props.selectedModel,
                            t('newSession.agyModel.notListed')
                        ).map((model) => (
                            <option key={model.modelId} value={model.modelId}>
                                {model.name ?? model.modelId}
                            </option>
                        ))}
                    </select>
                </div>
            )}
        </div>
    )
}
