import { PI_THINKING_LEVEL_LABELS } from '@hapi/protocol'
import type { PiThinkingLevelMap } from '@/types/api'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { isThinkingLevelSupported } from './piThinkingLevelOptions'

const ALL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

/**
 * Determine which thinking levels a model supports.
 * - reasoning=false → no levels
 * - reasoning=true (or unknown) + thinkingLevelMap → filter by map via isThinkingLevelSupported
 * - reasoning=true (or unknown) + no map → all levels except xhigh
 */
function getSupportedLevels(
    reasoning?: boolean,
    thinkingLevelMap?: PiThinkingLevelMap,
): string[] {
    if (reasoning === false) return []
    return ALL_LEVELS.filter((level) => isThinkingLevelSupported(level, thinkingLevelMap))
}

export function PiThinkingLevelPanel(props: {
    currentLevel: string | null
    reasoning?: boolean
    thinkingLevelMap?: PiThinkingLevelMap
    controlsDisabled?: boolean
    onSelect: (level: string | null) => void
    onClose: () => void
}) {
    const supportedLevels = getSupportedLevels(props.reasoning, props.thinkingLevelMap)
    const disabled = props.controlsDisabled ?? false

    if (supportedLevels.length === 0) return null

    return (
        <FloatingOverlay maxHeight={240}>
            <div className="py-2">
                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                    Thinking Level
                </div>
                {supportedLevels.map((level) => (
                    <button
                        key={level}
                        type="button"
                        disabled={disabled}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                            disabled
                                ? 'cursor-not-allowed opacity-50'
                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                        }`}
                        onClick={() => {
                            props.onSelect(props.currentLevel === level ? null : level)
                            props.onClose()
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                    >
                        <div
                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                props.currentLevel === level
                                    ? 'border-[var(--app-link)]'
                                    : 'border-[var(--app-hint)]'
                            }`}
                        >
                            {props.currentLevel === level && (
                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                            )}
                        </div>
                        <span className={props.currentLevel === level ? 'text-[var(--app-link)]' : ''}>
                            {PI_THINKING_LEVEL_LABELS[level as keyof typeof PI_THINKING_LEVEL_LABELS] ?? level}
                        </span>
                    </button>
                ))}
            </div>
        </FloatingOverlay>
    )
}
