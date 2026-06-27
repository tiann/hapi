import { PI_THINKING_LEVELS, PI_THINKING_LEVEL_LABELS } from '@hapi/protocol'

type OmpThinkingLevelOption = {
    value: string
    label: string
}

/**
 * OMP thinking-level option helpers.
 *
 * OMP (same Effort enum as Pi) carries per-model thinking info as an `efforts`
 * array (the levels the model supports) plus an optional `effortMap`. Unlike
 * Pi's flat `thinkingLevelMap`, the `efforts` array is the authoritative
 * supported-level list when present.
 */

/** Normalize a stored level: 'default'/'auto'/empty → null (use model default). */
function normalizeOmpThinkingLevel(level?: string | null): string | null {
    const trimmedLevel = level?.trim().toLowerCase()
    if (!trimmedLevel || trimmedLevel === 'default' || trimmedLevel === 'auto') {
        return null
    }
    return trimmedLevel
}

function formatOmpThinkingLevelLabel(level: string): string {
    return PI_THINKING_LEVEL_LABELS[level as keyof typeof PI_THINKING_LEVEL_LABELS]
        ?? `${level.charAt(0).toUpperCase()}${level.slice(1)}`
}

/**
 * Get thinking level options filtered by the model's `efforts` array.
 * - If `efforts` is present, only those levels are offered (plus 'off').
 * - If `efforts` is absent, fall back to all levels (model supports default set).
 * - A non-standard current level is always included so the picker shows it.
 */
export function getOmpThinkingLevelOptions(
    currentLevel?: string | null,
    efforts?: string[],
): OmpThinkingLevelOption[] {
    const normalizedCurrentLevel = normalizeOmpThinkingLevel(currentLevel)
    const options: OmpThinkingLevelOption[] = []

    // Always offer 'off' (disables reasoning) first. Normalize efforts to
    // lowercase so the includes() check against normalizedCurrentLevel matches
    // regardless of OMP's returned casing.
    const candidateLevels = efforts && efforts.length > 0
        ? ['off', ...efforts.map(e => e.toLowerCase())]
        : ['off', ...PI_THINKING_LEVELS]

    // Dedup while preserving order. Only track non-standard current level in
    // `seen` if we actually pushed it (prevents duplicating it from
    // candidateLevels). Standard levels must stay selectable.
    const seen = new Set<string>()

    // Include current level if it's non-standard (not in candidate set).
    if (
        normalizedCurrentLevel
        && !(candidateLevels as readonly string[]).includes(normalizedCurrentLevel)
    ) {
        seen.add(normalizedCurrentLevel)
        options.push({
            value: normalizedCurrentLevel,
            label: formatOmpThinkingLevelLabel(normalizedCurrentLevel)
        })
    }

    for (const level of candidateLevels) {
        if (seen.has(level)) continue
        seen.add(level)
        options.push({
            value: level,
            label: formatOmpThinkingLevelLabel(level)
        })
    }

    return options
}

/** Return the highest supported thinking level, or null if none. */
export function getHighestOmpThinkingLevel(efforts?: string[]): string | null {
    // Normalize efforts to lowercase so the includes() check against the
    // lowercase PI_THINKING_LEVELS matches regardless of OMP's returned casing.
    const supported = efforts && efforts.length > 0
        ? efforts.map(e => e.toLowerCase())
        : PI_THINKING_LEVELS
    let highest: string | null = null
    for (const level of PI_THINKING_LEVELS) {
        if ((supported as readonly string[]).includes(level)) {
            highest = level
        }
    }
    return highest
}
