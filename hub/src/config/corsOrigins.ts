/**
 * CORS origin normalization.
 *
 * Origins reach the hub from three places (CORS_ORIGINS env, settings.json and
 * the derived `publicUrl` origin) and are enforced twice (the Hono CORS
 * middleware and the Engine.IO `allowRequest` gate). Keeping one
 * implementation here makes both layers agree, and dropping entries that can
 * never match an `Origin` header avoids silently dead allowlist entries.
 */

import { parseHubUrl } from '@hapi/protocol'

const ALLOW_ALL = '*'
const NULL_ORIGIN = 'null'

/**
 * Normalize a single origin. Returns null when the value cannot be an origin
 * (missing scheme included - that used to be kept verbatim and never matched).
 */
export function normalizeOrigin(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed || trimmed === ALLOW_ALL) {
        return null
    }
    // The opaque `null` origin (sandboxed iframe, file://) cannot be expressed
    // as an origin string: repairing it to "http://null" would create an entry
    // nothing ever matches, and allowing it on purpose is a cross-origin trap.
    if (trimmed.toLowerCase() === NULL_ORIGIN) {
        return null
    }
    const parsed = parseHubUrl(trimmed)
    return parsed ? parsed.origin : null
}

export interface NormalizedOrigins {
    origins: string[]
    /** Entries that cannot be used as origins; callers warn about these. */
    dropped: string[]
    /** Entries that were repaired; callers log the value actually used. */
    repaired: Array<{ from: string; to: string }>
}

/**
 * Normalize an origin list. `*` short-circuits to allow-all; entries that are
 * not usable as origins are returned as `dropped` so callers can warn.
 */
export function normalizeOrigins(values: string[]): NormalizedOrigins {
    if (values.some((value) => value.trim() === ALLOW_ALL)) {
        return { origins: [ALLOW_ALL], dropped: [], repaired: [] }
    }
    const origins: string[] = []
    const dropped: string[] = []
    const repaired: Array<{ from: string; to: string }> = []
    for (const value of values) {
        const origin = normalizeOrigin(value)
        if (!origin) {
            dropped.push(value)
            continue
        }
        if (value.trim() !== origin && !repaired.some((entry) => entry.from === value)) {
            repaired.push({ from: value, to: origin })
        }
        if (!origins.includes(origin)) {
            origins.push(origin)
        }
    }
    return { origins, dropped, repaired }
}

/** Split a comma separated CORS_ORIGINS value without normalizing it. */
export function parseCorsOriginsEnv(raw: string): string[] {
    return raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
}

/**
 * Origin allowlist derived from `publicUrl`. The caller normalizes `publicUrl`
 * first, so this only fails when the value was not a hub URL at all.
 */
export function deriveCorsOrigins(publicUrl: string): string[] {
    const origin = normalizeOrigin(publicUrl)
    return origin ? [origin] : []
}

/** Merge the configured origins with the extra origins (e.g. relay web app). */
export function mergeCorsOrigins(base: string[], extra: string[]): string[] {
    if (base.includes(ALLOW_ALL) || extra.includes(ALLOW_ALL)) {
        return [ALLOW_ALL]
    }
    return Array.from(new Set([...base, ...extra]))
}
