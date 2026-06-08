import { PI_THINKING_LEVELS, PI_THINKING_LEVEL_LABELS, type PiThinkingLevel } from '@hapi/protocol'

export type PiThinkingLevelOption = {
    value: string
    label: string
}

function normalizePiThinkingLevel(level?: string | null): string | null {
    const trimmedLevel = level?.trim().toLowerCase()
    if (!trimmedLevel || trimmedLevel === 'default' || trimmedLevel === 'auto') {
        return null
    }

    return trimmedLevel
}

export function getPiThinkingLevelOptions(currentLevel?: string | null): PiThinkingLevelOption[] {
    const normalizedCurrentLevel = normalizePiThinkingLevel(currentLevel)
    const options: PiThinkingLevelOption[] = []

    if (
        normalizedCurrentLevel
        && !(PI_THINKING_LEVELS as readonly string[]).includes(normalizedCurrentLevel)
    ) {
        options.push({
            value: normalizedCurrentLevel,
            label: formatPiThinkingLevelLabel(normalizedCurrentLevel)
        })
    }

    options.push(...PI_THINKING_LEVELS.map((level) => ({
        value: level,
        label: PI_THINKING_LEVEL_LABELS[level]
    })))

    return options
}

function formatPiThinkingLevelLabel(level: string): string {
    return PI_THINKING_LEVEL_LABELS[level as PiThinkingLevel]
        ?? `${level.charAt(0).toUpperCase()}${level.slice(1)}`
}
