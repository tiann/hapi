type TitleWriteOptions = { allowTitleUpdate?: boolean; titleLocked?: boolean }

const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null

/** Only a user title save may change the lock; enforce against the raw persisted row. */
export function preserveSessionTitle(prior: unknown, incoming: unknown, options?: TitleWriteOptions): unknown {
    const previous = record(prior)
    const locked = options?.titleLocked ?? (previous?.titleLocked === true)
    const protectTitle = previous?.titleLocked === true && !options?.allowTitleUpdate
    const next = record(incoming)
    if (!next && !locked && !protectTitle) return incoming
    const result = { ...(next ?? previous ?? {}) }
    delete result.titleLocked
    if (protectTitle) {
        for (const key of ['name', 'summary'] as const) {
            if (Object.prototype.hasOwnProperty.call(previous, key)) result[key] = previous![key]
            else delete result[key]
        }
    }
    if (locked) result.titleLocked = true
    return result
}
