export function clampAliveTime(t: number): number | null {
    if (!Number.isFinite(t)) return null
    const now = Date.now()
    if (t > now) return now
    if (t < now - 1000 * 60 * 10) return null
    return t
}
