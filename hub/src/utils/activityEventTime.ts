export function validateActivityEventTime(
    t: number,
    now: number = Date.now(),
    options: { allowHistorical?: boolean } = {}
): number | null {
    if (!Number.isFinite(t)) return null
    if (t > now + 1000 * 60 * 10) return null
    if (!options.allowHistorical && t < now - 1000 * 60 * 10) return null
    return t
}
