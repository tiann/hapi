/**
 * Project registry helpers for multi-host GitHub PR refs.
 *
 * Upstreamable core: validate github.com + GitHub Enterprise (*.ghe.com) hosts
 * without requiring operator-private `config/projects.yaml`. Fork tooling may
 * call `configureGitHubHosts` after reading estate YAML.
 */

export interface ProjectTarget {
    id: string
    repo: string
    host: string
    control: 'ours' | 'theirs'
    primary: boolean
}

export interface Project {
    name: string
    description: string
    targets: ProjectTarget[]
}

export interface ProjectRegistry {
    projects: Record<string, Project>
    settings: {
        valid_hosts: string[]
        default_host: string
        discovery?: {
            merged_lookback_days: number
            min_pr_number: number
        }
        classification?: {
            stale_ms: number
            emit_events: boolean
        }
    }
}

const DEFAULT_HOST = 'github.com'

/** Explicit hosts beyond github.com / *.ghe.com (tests + fork YAML inject). */
let configuredHosts: string[] = []

/**
 * Replace the explicit host allowlist (does not remove github.com or *.ghe.com).
 * Pass `[]` to clear. Used by tests and optional fork estate loaders.
 */
export function configureGitHubHosts(hosts: readonly string[]): void {
    configuredHosts = [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))]
}

/** Test/helper: clear inject so unit tests do not leak hosts. */
export function resetGitHubHostConfiguration(): void {
    configuredHosts = []
}

export function getValidGitHubHosts(): string[] {
    return [DEFAULT_HOST, ...configuredHosts.filter((host) => host !== DEFAULT_HOST)]
}

/**
 * True for github.com, any `*.ghe.com` Enterprise host, or configureGitHubHosts entries.
 */
export function isValidGitHubHost(host: string): boolean {
    const normalized = host.trim().toLowerCase()
    if (!normalized) return false
    if (normalized === DEFAULT_HOST) return true
    if (configuredHosts.includes(normalized)) return true
    // GitHub Enterprise Server / EMU cloud (e.g. lhs.ghe.com). Require a label
    // before `.ghe.com` so a bare `ghe.com` is rejected.
    if (normalized.endsWith('.ghe.com') && normalized.length > '.ghe.com'.length) {
        return true
    }
    return false
}

export function getGitHubUrlForRepo(repo: string, number: number, host: string = DEFAULT_HOST): string {
    return `https://${host}/${repo}/pull/${number}`
}

/** Hostname from a PR URL; falls back to github.com on parse failure. */
export function hostFromGithubPrUrl(url: string): string {
    try {
        return new URL(url).hostname || DEFAULT_HOST
    } catch {
        return DEFAULT_HOST
    }
}

/**
 * Identity key for dedupe / upsert: host + case-insensitive repo + number.
 * Distinct forges with the same owner/repo#N must not collide.
 */
export function githubPrIdentityKey(repo: string, number: number, hostOrUrl: string): string {
    const host = hostOrUrl.includes('://')
        ? hostFromGithubPrUrl(hostOrUrl)
        : (hostOrUrl.trim() || DEFAULT_HOST)
    return `github_pr:${host.toLowerCase()}:${repo.toLowerCase()}#${number}`
}

/**
 * Registry snapshot for callers that expect the multi-repo shape.
 * Browser-safe: no filesystem YAML (fork Meta loads hosts via configureGitHubHosts).
 */
export function loadProjectRegistry(): ProjectRegistry {
    return {
        projects: {
            hapi: {
                name: 'HAPI Platform',
                description: 'Local-first AI agent platform',
                targets: [
                    { id: 'upstream', repo: 'tiann/hapi', host: DEFAULT_HOST, control: 'theirs', primary: true },
                    { id: 'fork', repo: 'heavygee/hapi', host: DEFAULT_HOST, control: 'ours', primary: false }
                ]
            }
        },
        settings: {
            valid_hosts: getValidGitHubHosts(),
            default_host: DEFAULT_HOST
        }
    }
}
