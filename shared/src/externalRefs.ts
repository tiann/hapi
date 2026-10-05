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
import { getGitHubUrlForRepo, hostFromGithubPrUrl, isValidGitHubHost } from './projectRegistry'

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

export function githubPrUrl(repo: string, number: number, host: string = 'github.com'): string {
    return getGitHubUrlForRepo(repo, number, host)
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

    if (url.protocol !== 'https:' || !isValidGitHubHost(url.hostname)) {
        return { ok: false, error: 'expected https://<github-or-ghes-host>/.../pull/N URL' }
    }

    const pathMatch = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/)
    if (!pathMatch) {
        return { ok: false, error: 'expected https://<host>/owner/repo/pull/N URL' }
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
        // Preserve GHES / custom host — do not rewrite to github.com.
        url: githubPrUrl(repoParsed.data, number, url.hostname)
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
    /** Forge host when not github.com (e.g. lhs.ghe.com). Ignored if `url` is set. */
    host?: string
    /** Full PR URL; when set, wins over host+repo+number construction. */
    url?: string
}): GithubPrExternalRef {
    const url = input.url
        ?? githubPrUrl(input.repo, input.number, input.host ?? 'github.com')
    return {
        kind: 'github_pr',
        repo: input.repo,
        number: input.number,
        url,
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

/** GitHub owner/repo paths are case-insensitive; forge host is part of identity. */
export function isSameGithubPrIdentity(
    candidate: ExternalRef,
    repo: string,
    number: number,
    host: string = 'github.com'
): boolean {
    if (candidate.kind !== 'github_pr') return false
    if (candidate.repo.toLowerCase() !== repo.toLowerCase() || candidate.number !== number) {
        return false
    }
    return hostFromGithubPrUrl(candidate.url).toLowerCase() === host.toLowerCase()
}

/**
 * Insert/replace a GitHub PR ref while preserving cached forge/estate health on
 * the same repo#number identity, and replacing any other primary when linking primary.
 */
export function upsertGithubPrIntoExternalRefs(
    current: readonly ExternalRef[],
    ref: GithubPrExternalRef
): ExternalRef[] {
    const host = hostFromGithubPrUrl(ref.url)
    const same = current.find((candidate): candidate is GithubPrExternalRef =>
        isSameGithubPrIdentity(candidate, ref.repo, ref.number, host)
    )
    const nextRef: GithubPrExternalRef = same
        ? {
            ...same,
            ...ref,
            // Keep the stored slug casing so re-links with different case merge.
            repo: same.repo,
            // Keep forge host from the incoming URL when present, else the stored
            // one — but always rebuild with `same.repo` casing.
            url: githubPrUrl(
                same.repo,
                same.number,
                hostFromGithubPrUrl(ref.url ?? same.url)
            ),
            number: same.number
        }
        : ref
    const retained = current.filter((candidate) => {
        if (isSameGithubPrIdentity(candidate, ref.repo, ref.number, host)) {
            return false
        }
        if (nextRef.role === 'primary'
            && candidate.kind === 'github_pr'
            && candidate.role === 'primary') {
            return false
        }
        return true
    })
    return [...retained, nextRef]
}

/**
 * Compact chip glyph for session rows: status emoji + `#N` (or `?` when stale).
 * Full `repo#N` + status copy lives in the tooltip / aria-label.
 * Fallback `PR#N` when a forge snapshot has no emoji (upstream defaults).
 */
export function formatGithubPrChipLabel(
    ref: GithubPrExternalRef,
    display: ResolvedPrChipDisplay
): string {
    const number = `#${ref.number}`
    if (display.stale) return `?${number}`
    const emoji = display.emoji.trim()
    if (emoji) return `${emoji}${number}`
    return `PR${number}`
}

export function resolveGithubPrChipDisplay(
    ref: GithubPrExternalRef,
    profile: PrChipDisplayProfile = DEFAULT_PR_CHIP_DISPLAY,
    nowMs: number = Date.now()
): ResolvedPrChipDisplay {
    return resolvePrChipDisplay(ref, profile, nowMs)
}
