/**
 * Optional Cloudflare Access configuration (env-only, never persisted).
 *
 * All three variables must be set for the feature to be enabled; any partial
 * or malformed bundle throws so the hub fails fast at startup instead of
 * silently running with a broken login path.
 */

export interface CloudflareAccessConfig {
    /** Lowercased <team>.cloudflareaccess.com hostname */
    readonly teamDomain: string
    /** Cloudflare Access application audience (AUD) */
    readonly audience: string
    /** Normalized (lowercased) email -> namespace allowlist */
    readonly users: Record<string, string>
}

const TEAM_DOMAIN_SUFFIX = '.cloudflareaccess.com'
const TEAM_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const EMAIL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i

function isPresent(value: string | undefined): value is string {
    return typeof value === 'string' && value.length > 0
}

function parseTeamDomain(raw: string): string {
    if (/\s/.test(raw)) {
        throw new Error('HAPI_CLOUDFLARE_ACCESS_TEAM_DOMAIN must not contain whitespace')
    }
    const normalized = raw.toLowerCase()
    if (!normalized.endsWith(TEAM_DOMAIN_SUFFIX)) {
        throw new Error(`HAPI_CLOUDFLARE_ACCESS_TEAM_DOMAIN must be a <team>${TEAM_DOMAIN_SUFFIX} hostname`)
    }
    const team = normalized.slice(0, normalized.length - TEAM_DOMAIN_SUFFIX.length)
    if (!TEAM_LABEL_PATTERN.test(team)) {
        throw new Error(`HAPI_CLOUDFLARE_ACCESS_TEAM_DOMAIN must be a <team>${TEAM_DOMAIN_SUFFIX} hostname`)
    }
    return normalized
}

function parseAudience(raw: string): string {
    if (raw.trim().length === 0) {
        throw new Error('HAPI_CLOUDFLARE_ACCESS_AUD must be a nonempty audience string')
    }
    return raw.trim()
}

function parseUsers(raw: string): Record<string, string> {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error('HAPI_CLOUDFLARE_ACCESS_USERS must be a JSON object mapping emails to namespaces')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('HAPI_CLOUDFLARE_ACCESS_USERS must be a JSON object mapping emails to namespaces')
    }

    const entries = Object.entries(parsed as Record<string, unknown>)
    if (entries.length === 0) {
        throw new Error('HAPI_CLOUDFLARE_ACCESS_USERS must contain at least one email')
    }

    const users: Record<string, string> = {}
    for (const [email, namespace] of entries) {
        if (!EMAIL_PATTERN.test(email)) {
            throw new Error('HAPI_CLOUDFLARE_ACCESS_USERS keys must be valid email addresses')
        }
        const normalizedEmail = email.toLowerCase()
        if (normalizedEmail in users) {
            throw new Error('HAPI_CLOUDFLARE_ACCESS_USERS must not contain case-folded duplicate emails')
        }
        if (typeof namespace !== 'string' || namespace.length === 0 || namespace !== namespace.trim()) {
            throw new Error('HAPI_CLOUDFLARE_ACCESS_USERS namespaces must be nonempty and unpadded')
        }
        users[normalizedEmail] = namespace
    }
    return users
}

/**
 * Parse the env-only Cloudflare Access bundle.
 * Returns null when the feature is disabled (all variables absent/empty);
 * throws when the configuration is partial or malformed.
 */
export function parseCloudflareAccessConfig(env: Record<string, string | undefined>): CloudflareAccessConfig | null {
    const teamDomain = env.HAPI_CLOUDFLARE_ACCESS_TEAM_DOMAIN
    const audience = env.HAPI_CLOUDFLARE_ACCESS_AUD
    const users = env.HAPI_CLOUDFLARE_ACCESS_USERS

    if (!isPresent(teamDomain) && !isPresent(audience) && !isPresent(users)) {
        return null
    }
    if (!isPresent(teamDomain) || !isPresent(audience) || !isPresent(users)) {
        throw new Error(
            'Incomplete Cloudflare Access configuration: set all of '
            + 'HAPI_CLOUDFLARE_ACCESS_TEAM_DOMAIN, HAPI_CLOUDFLARE_ACCESS_AUD, '
            + 'HAPI_CLOUDFLARE_ACCESS_USERS (or none)'
        )
    }

    return {
        teamDomain: parseTeamDomain(teamDomain),
        audience: parseAudience(audience),
        users: parseUsers(users)
    }
}
