import { z } from 'zod'
import type { GithubPrExternalRef } from './schemas'

/** Presentation tone buckets — not forge enums; UI CSS keys. */
export const PrChipToneSchema = z.enum([
    'ok',
    'pending',
    'needs_work',
    'merged',
    'muted',
    'unknown'
])
export type PrChipTone = z.infer<typeof PrChipToneSchema>

export const PrChipDisplayEntrySchema = z.object({
    emoji: z.string().max(8).optional(),
    tone: PrChipToneSchema.optional(),
    label: z.string().max(80).optional(),
    action: z.string().max(400).optional()
})
export type PrChipDisplayEntry = z.infer<typeof PrChipDisplayEntrySchema>

/**
 * Estate-overridable chip presentation.
 * File: `$HAPI_HOME/pr-chip-display.json` (optional). Missing → defaults.
 */
export const PrChipDisplayProfileSchema = z.object({
    staleMs: z.number().int().positive().default(2 * 60 * 60 * 1000),
    forge: z.record(z.string(), PrChipDisplayEntrySchema).default({}),
    estateCodes: z.record(z.string(), PrChipDisplayEntrySchema).default({})
})
export type PrChipDisplayProfile = z.infer<typeof PrChipDisplayProfileSchema>

/** Upstream-safe defaults: forge facts only, no Meta prose / mood-ring emoji. */
export const DEFAULT_PR_CHIP_DISPLAY: PrChipDisplayProfile = {
    staleMs: 2 * 60 * 60 * 1000,
    forge: {
        'openState.merged': { tone: 'merged', label: 'merged' },
        'openState.closed': { tone: 'muted', label: 'closed' },
        'openState.draft': { tone: 'muted', label: 'draft' },
        'checks.fail': { tone: 'needs_work', label: 'checks failed' },
        'merge.conflicting': { tone: 'needs_work', label: 'conflicts' },
        'merge.blocked': { tone: 'needs_work', label: 'merge blocked' },
        'checks.pending': { tone: 'pending', label: 'checks running' },
        'merge.unstable': { tone: 'pending', label: 'unstable' },
        'merge.behind': { tone: 'pending', label: 'behind base' },
        'merge.clean+checks.pass': { tone: 'ok', label: 'ready to merge' },
        'merge.clean': { tone: 'ok', label: 'mergeable' },
        'checks.pass': { tone: 'ok', label: 'checks passed' }
    },
    estateCodes: {}
}

export function mergePrChipDisplayProfile(
    overrides: unknown | null | undefined
): PrChipDisplayProfile {
    if (overrides == null) return DEFAULT_PR_CHIP_DISPLAY
    const parsed = PrChipDisplayProfileSchema.safeParse(overrides)
    if (!parsed.success) return DEFAULT_PR_CHIP_DISPLAY
    return {
        staleMs: parsed.data.staleMs,
        forge: { ...DEFAULT_PR_CHIP_DISPLAY.forge, ...parsed.data.forge },
        estateCodes: { ...DEFAULT_PR_CHIP_DISPLAY.estateCodes, ...parsed.data.estateCodes }
    }
}

export type ResolvedPrChipDisplay = {
    stale: boolean
    hasSnapshot: boolean
    emoji: string
    tone: PrChipTone | undefined
    label: string | undefined
    action: string | undefined
}

function forgeCandidateKeys(ref: GithubPrExternalRef): string[] {
    const keys: string[] = []
    if (ref.merge && ref.checks) {
        keys.push(`merge.${ref.merge}+checks.${ref.checks}`)
    }
    if (ref.openState) keys.push(`openState.${ref.openState}`)
    if (ref.checks) keys.push(`checks.${ref.checks}`)
    if (ref.merge) keys.push(`merge.${ref.merge}`)
    return keys
}

function pickForgeEntry(
    ref: GithubPrExternalRef,
    forge: Record<string, PrChipDisplayEntry>
): PrChipDisplayEntry | undefined {
    for (const key of forgeCandidateKeys(ref)) {
        const entry = forge[key]
        if (entry) return entry
    }
    return undefined
}

/**
 * Resolve chip presentation from forge snapshot + estate display profile.
 * Never live-queries GitHub. Estate codes win over forge rules when present.
 */
export function resolvePrChipDisplay(
    ref: GithubPrExternalRef,
    profile: PrChipDisplayProfile = DEFAULT_PR_CHIP_DISPLAY,
    nowMs: number = Date.now()
): ResolvedPrChipDisplay {
    const hasSnapshot = Boolean(
        ref.openState || ref.checks || ref.merge || ref.estateCode
    )
    const stale = hasSnapshot && (
        typeof ref.statusCheckedAt !== 'number'
        || nowMs - ref.statusCheckedAt > profile.staleMs
    )

    const estate = ref.estateCode ? profile.estateCodes[ref.estateCode] : undefined
    const forge = pickForgeEntry(ref, profile.forge)
    const entry = estate ?? forge

    if (!hasSnapshot) {
        return {
            stale: false,
            hasSnapshot: false,
            emoji: '',
            tone: undefined,
            label: undefined,
            action: undefined
        }
    }

    if (stale) {
        return {
            stale: true,
            hasSnapshot: true,
            emoji: '?',
            tone: 'unknown',
            label: entry?.label,
            action: undefined
        }
    }

    return {
        stale: false,
        hasSnapshot: true,
        emoji: entry?.emoji ?? '',
        tone: entry?.tone,
        label: entry?.label,
        action: entry?.action
    }
}
