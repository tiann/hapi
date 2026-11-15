/**
 * Stable content serialization for import comparisons. Shared by the
 * content-prefix matcher and flavor compare keys; both sides of a comparison
 * must canonicalize identically.
 */

export function stableSerializeContent(value: unknown): string {
    if (value === null || value === undefined) {
        return String(value)
    }
    if (typeof value === 'string') {
        return JSON.stringify(value)
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return JSON.stringify(value)
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableSerializeContent(item)).join(',')}]`
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        const keys = Object.keys(record).sort()
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerializeContent(record[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
}

/** Trailing-whitespace-insensitive user text normalization for comparisons. */
export function normalizeComparableText(value: string): string {
    return value.replace(/\s+$/u, '')
}