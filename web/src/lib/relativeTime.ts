export function formatSessionListDate(date: Date): string {
    const year = String(date.getFullYear())
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}/${month}/${day}`
}

/**
 * Formats an epoch ms / s value as a localised "Nm ago" / "Nh ago" / date label.
 * Accepts both ms and seconds; values smaller than 1e12 are treated as seconds.
 *
 * Returns `null` when the input is not finite.
 */
export function formatRelativeTime(
    value: number,
    t: (key: string, params?: Record<string, string | number>) => string
): string | null {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return null
    const delta = Date.now() - ms
    if (delta < 60_000) return t('session.time.justNow')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return t('session.time.minutesAgo', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('session.time.hoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return t('session.time.daysAgo', { n: days })
    return formatSessionListDate(new Date(ms))
}

/**
 * Absolute date+time string for tooltips that want the precise stamp
 * alongside the smart-relative label. Locale-aware.
 */
export function formatAbsoluteDateTime(value: number): string | null {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return null
    return new Date(ms).toLocaleString()
}
