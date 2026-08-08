import type {
    ExternalRef,
    GithubPrExternalRef,
    GithubPrChecks,
    GithubPrMerge,
    GithubPrOpenState
} from './schemas'
import { GithubRepoSlugSchema } from './schemas'
import {
    DEFAULT_PR_CHIP_DISPLAY,
    type PrChipDisplayProfile,
    type ResolvedPrChipDisplay,
    resolvePrChipDisplay
} from './prChipDisplay'

/**
 * Primary GitHub PR chip source. Title/emoji parsing is intentionally not used.
 */
export function getPrimaryGithubPrRef(
    refs: readonly ExternalRef[] | null | undefined
): GithubPrExternalRef | null {
    if (!refs?.length) return null
    for (const ref of refs) {
        if (ref.kind === 'github_pr' && ref.role === 'primary') {
            return ref
        }
    }
    return null
}

export function githubPrUrl(repo: string, number: number): string {
    return `https://github.com/${repo}/pull/${number}`
}

export type ParseGithubPrInputResult =
    | { ok: true; repo: string; number: number; url: string }
    | { ok: false; error: string }

/**
 * Accept a GitHub PR URL or `owner/repo#N` / `owner/repo#PR N` style input.
 * Does not call the network; shape validation only.
 */
export function parseGithubPrInput(raw: string): ParseGithubPrInputResult {
    const trimmed = raw.trim()
    if (!trimmed) {
        return { ok: false, error: 'empty input' }
    }

    const hashMatch = trimmed.match(/^([^/\s]+\/[^/\s]+)\s*#\s*(?:PR\s*)?(\d+)$/i)
    if (hashMatch) {
        const repo = hashMatch[1]
        const number = Number(hashMatch[2])
        const repoParsed = GithubRepoSlugSchema.safeParse(repo)
        if (!repoParsed.success || !Number.isInteger(number) || number <= 0) {
            return { ok: false, error: 'invalid owner/repo#N' }
        }
        return { ok: true, repo: repoParsed.data, number, url: githubPrUrl(repoParsed.data, number) }
    }

    let url: URL
    try {
        url = new URL(trimmed)
    } catch {
        return { ok: false, error: 'expected GitHub PR URL or owner/repo#N' }
    }

    if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
        return { ok: false, error: 'expected https://github.com/.../pull/N URL' }
    }

    const pathMatch = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/)
    if (!pathMatch) {
        return { ok: false, error: 'expected https://github.com/owner/repo/pull/N URL' }
    }

    const repoParsed = GithubRepoSlugSchema.safeParse(pathMatch[1])
    const number = Number(pathMatch[2])
    if (!repoParsed.success || !Number.isInteger(number) || number <= 0) {
        return { ok: false, error: 'invalid GitHub PR URL' }
    }

    return {
        ok: true,
        repo: repoParsed.data,
        number,
        url: githubPrUrl(repoParsed.data, number)
    }
}

export function buildGithubPrExternalRef(input: {
    repo: string
    number: number
    role?: 'primary' | 'secondary'
    source?: 'agent' | 'user' | 'inferred'
    linkedAt?: number
    openState?: GithubPrOpenState
    checks?: GithubPrChecks
    merge?: GithubPrMerge
    statusCheckedAt?: number
    estateCode?: string
}): GithubPrExternalRef {
    return {
        kind: 'github_pr',
        repo: input.repo,
        number: input.number,
        url: githubPrUrl(input.repo, input.number),
        role: input.role ?? 'primary',
        ...(input.source ? { source: input.source } : {}),
        ...(input.linkedAt ? { linkedAt: input.linkedAt } : {}),
        ...(input.openState ? { openState: input.openState } : {}),
        ...(input.checks ? { checks: input.checks } : {}),
        ...(input.merge ? { merge: input.merge } : {}),
        ...(input.statusCheckedAt ? { statusCheckedAt: input.statusCheckedAt } : {}),
        ...(input.estateCode ? { estateCode: input.estateCode } : {})
    }
}

/**
 * Compact chip glyph for session rows: status emoji only (or `?` when stale).
 * Full `repo#N` + status copy lives in the tooltip / aria-label — not the
 * visible chip — so multi-digit PR numbers do not crowd the list.
 * Fallback `PR` when a forge snapshot has no emoji (upstream defaults).
 */
export function formatGithubPrChipLabel(
    _ref: GithubPrExternalRef,
    display: ResolvedPrChipDisplay
): string {
    if (display.stale) return '?'
    const emoji = display.emoji.trim()
    if (emoji) return emoji
    return 'PR'
}

export function resolveGithubPrChipDisplay(
    ref: GithubPrExternalRef,
    profile: PrChipDisplayProfile = DEFAULT_PR_CHIP_DISPLAY,
    nowMs: number = Date.now()
): ResolvedPrChipDisplay {
    return resolvePrChipDisplay(ref, profile, nowMs)
}
