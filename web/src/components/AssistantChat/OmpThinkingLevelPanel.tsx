import { getOmpThinkingLevelOptions } from './ompThinkingLevelOptions'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'

/**
 * OMP thinking-level picker.
 *
 * OMP models expose a per-model `efforts` array (the supported levels). When
 * present, only those levels (plus 'off') are offered. When absent or the model
 * has reasoning=false, the panel hides itself.
 */
export function OmpThinkingLevelPanel(props: {
    currentLevel: string | null
    reasoning?: boolean
    efforts?: string[]
    controlsDisabled?: boolean
    onSelect: (level: string | null) => void
    onClose: () => void
}) {
    // No reasoning → no thinking levels to pick.
    if (props.reasoning === false) return null

    const options = getOmpThinkingLevelOptions(props.currentLevel, props.efforts)
    if (options.length === 0) return null

    const disabled = props.controlsDisabled ?? false
    // option.value is normalized to lowercase inside getOmpThinkingLevelOptions;
    // normalize currentLevel the same way so selection highlight + toggle match.
    const normalizedCurrent = props.currentLevel?.trim().toLowerCase() ?? null

    return (
        <FloatingOverlay maxHeight={240}>
            <div className="py-2">
                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                    Thinking Level
                </div>
                {options.map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        disabled={disabled}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                            disabled
                                ? 'cursor-not-allowed opacity-50'
                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                        }`}
                        onClick={() => {
                            props.onSelect(normalizedCurrent === option.value ? null : option.value)
                            props.onClose()
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                    >
                        <div
                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                normalizedCurrent === option.value
                                    ? 'border-[var(--app-link)]'
                                    : 'border-[var(--app-hint)]'
                            }`}
                        >
                            {normalizedCurrent === option.value && (
                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                            )}
                        </div>
                        <span className={normalizedCurrent === option.value ? 'text-[var(--app-link)]' : ''}>
                            {option.label}
                        </span>
                    </button>
                ))}
            </div>
        </FloatingOverlay>
    )
}
