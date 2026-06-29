import { useTranslation } from '@/lib/use-translation'
import type { OmpModelSummary } from '@/types/api'
import { groupOmpModelsByProvider } from './ompModelGroups'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'

export function OmpModelPanel(props: {
    models: OmpModelSummary[]
    currentModel: { provider: string; modelId: string } | null
    controlsDisabled?: boolean
    onSelect: (model: OmpModelSummary) => void
    onClose: () => void
}) {
    const { t } = useTranslation()
    const groups = groupOmpModelsByProvider(props.models)
    const disabled = props.controlsDisabled ?? false

    const isSelected = (ompModel: OmpModelSummary) =>
        props.currentModel?.provider === ompModel.provider &&
        props.currentModel?.modelId === ompModel.modelId

    return (
        <FloatingOverlay maxHeight={360}>
            <div className="py-2">
                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                    {t('misc.model')}
                </div>
                {groups.map((group) => (
                    <div key={group.provider}>
                        <div className="px-3 pt-2 pb-0.5 text-xs font-medium text-[var(--app-link)]">
                            {group.label}
                        </div>
                        {group.models.map((ompModel) => {
                            const selected = isSelected(ompModel)
                            return (
                                <button
                                    key={`${ompModel.provider}:${ompModel.modelId}`}
                                    type="button"
                                    disabled={disabled}
                                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                        disabled
                                            ? 'cursor-not-allowed opacity-50'
                                            : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                    }`}
                                    onClick={() => {
                                        props.onSelect(ompModel)
                                        props.onClose()
                                    }}
                                    onMouseDown={(e) => e.preventDefault()}
                                >
                                    <div
                                        className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                            selected
                                                ? 'border-[var(--app-link)]'
                                                : 'border-[var(--app-hint)]'
                                        }`}
                                    >
                                        {selected && (
                                            <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                        )}
                                    </div>
                                    <span className={selected ? 'text-[var(--app-link)]' : ''}>
                                        {ompModel.name ?? ompModel.modelId}
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                ))}
            </div>
        </FloatingOverlay>
    )
}
