import { PI_THINKING_LEVELS, PI_THINKING_LEVEL_LABELS, type PiThinkingLevel } from '@hapi/protocol'
import type { PiThinkingLevelMap } from '@/types/api'

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

function formatPiThinkingLevelLabel(level: string): string {
    return PI_THINKING_LEVEL_LABELS[level as PiThinkingLevel]
        ?? `${level.charAt(0).toUpperCase()}${level.slice(1)}`
}

/**
 * Get thinking level options filtered by the model's thinkingLevelMap.
 * Levels mapped to `null` in the map are unsupported and excluded.
 * Levels not present in the map are included (treated as supported with default mapping).
 */
export function getPiThinkingLevelOptions(
    currentLevel?: string | null,
    thinkingLevelMap?: PiThinkingLevelMap
): PiThinkingLevelOption[] {
    const normalizedCurrentLevel = normalizePiThinkingLevel(currentLevel)
    const options: PiThinkingLevelOption[] = []

    // Include current level if it's non-standard (custom)
    if (
        normalizedCurrentLevel
        && !(PI_THINKING_LEVELS as readonly string[]).includes(normalizedCurrentLevel)
        && !isLevelExcluded(normalizedCurrentLevel, thinkingLevelMap)
    ) {
        options.push({
            value: normalizedCurrentLevel,
            label: formatPiThinkingLevelLabel(normalizedCurrentLevel)
        })
    }

    options.push(...PI_THINKING_LEVELS
        .filter((level) => !isLevelExcluded(level, thinkingLevelMap))
        .map((level) => ({
            value: level,
            label: PI_THINKING_LEVEL_LABELS[level]
        }))
    )

    return options
}

/** Check whether a thinking level is supported by the model's thinkingLevelMap */
export function isThinkingLevelSupported(level: string, map?: PiThinkingLevelMap): boolean {
    // xhigh requires explicit opt-in via the map
    if (level === 'xhigh') {
        if (!map || !(level in map)) return false
        return map[level] !== null
    }
    if (!map || !(level in map)) return true
    return map[level] !== null
}

/** A level is excluded if it maps to `null` in the thinkingLevelMap, or xhigh without explicit opt-in */
function isLevelExcluded(level: string, map?: PiThinkingLevelMap): boolean {
    return !isThinkingLevelSupported(level, map)
}

/** Return the highest supported thinking level, or null if none */
export function getHighestThinkingLevel(map?: PiThinkingLevelMap): string | null {
    for (let i = PI_THINKING_LEVELS.length - 1; i >= 0; i--) {
        if (isThinkingLevelSupported(PI_THINKING_LEVELS[i]!, map)) {
            return PI_THINKING_LEVELS[i]!
        }
    }
    return null
}
