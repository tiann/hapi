/**
 * Canonical JSON for golden fixtures: recursively sorted object keys, 4-space
 * indent, LF line endings, single trailing newline, `undefined` object values
 * stripped (array holes/undefined entries become null, matching
 * JSON.stringify). Running the generator twice must be byte-identical — this
 * is what allows a CI git-dirty gate to detect web-pipeline drift.
 */
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => (item === undefined ? null : canonicalize(item)))
    }
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>
        const sorted: Record<string, unknown> = {}
        for (const key of Object.keys(record).sort()) {
            const item = record[key]
            if (item === undefined) continue
            sorted[key] = canonicalize(item)
        }
        return sorted
    }
    return value
}

export function toCanonicalJson(value: unknown): string {
    return `${JSON.stringify(canonicalize(value), null, 4)}\n`
}
