/**
 * Formatting helpers for scheduled-send UX (queued bar + session-list clock tooltip).
 */

/** Locale-aware absolute fire time, e.g. "Jun 16, 1:45 PM". */
export function formatScheduledTime(scheduledAt: number): string {
    const date = new Date(scheduledAt)
    const now = new Date()
    const opts: Intl.DateTimeFormatOptions = {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }
    if (date.getFullYear() !== now.getFullYear()) {
        opts.year = 'numeric'
    }
    return date.toLocaleString(undefined, opts)
}

/** Relative countdown until a future epoch-ms, e.g. "in 5m". Returns null when invalid. */
export function formatFutureRelativeTime(
    value: number,
    t: (key: string, params?: Record<string, string | number>) => string
): string | null {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return null
    const delta = ms - Date.now()
    if (delta <= 0) return t('session.time.soon')
    if (delta < 60_000) return t('session.time.inLessThanMinute')
    const minutes = Math.ceil(delta / 60_000)
    if (minutes < 60) return t('session.time.inMinutes', { n: minutes })
    const hours = Math.ceil(minutes / 60)
    if (hours < 24) return t('session.time.inHours', { n: hours })
    const days = Math.ceil(hours / 24)
    if (days < 7) return t('session.time.inDays', { n: days })
    return formatScheduledTime(ms)
}

/** "in 5m · Jun 16, 1:45 PM" for tooltip / queued copy. */
export function formatScheduledFireLabel(
    scheduledAt: number,
    t: (key: string, params?: Record<string, string | number>) => string
): string | null {
    const relative = formatFutureRelativeTime(scheduledAt, t)
    if (!relative) return null
    const absolute = formatScheduledTime(scheduledAt)
    // When the countdown is already an absolute date (>7d), don't duplicate.
    if (relative === absolute) return relative
    return `${relative} · ${absolute}`
}

/** Session-list clock tooltip body from summary fields. */
export function formatScheduledTooltipDetail(
    summary: { futureScheduledMessageCount: number; nextScheduledAt: number | null },
    t: (key: string, params?: Record<string, string | number>) => string
): string {
    if (summary.nextScheduledAt != null) {
        const when = formatScheduledFireLabel(summary.nextScheduledAt, t)
        if (when) {
            if (summary.futureScheduledMessageCount > 1) {
                return t('session.tooltip.scheduled.next', {
                    when,
                    more: summary.futureScheduledMessageCount - 1
                })
            }
            return t('session.tooltip.scheduled.fires', { when })
        }
    }
    return t('session.tooltip.scheduled.body')
}
