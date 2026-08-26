package app.hapi.companion.feature.sessions

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.hapi.companion.R

/**
 * Compact relative-age label for list rows ("now", "5m", "3h", "2d").
 * Minute granularity is deliberate: it is why sub-minute `activeAt` churn can
 * be dropped as render-irrelevant (`sse.md#keep-alive-noise`).
 *
 * The unit suffixes (m/h/d/w/mo/y) deliberately stay Latin across locales —
 * timestamp-style shorthand, like the web's compact ages; only the sub-minute
 * "now" word localizes (via [localizedRelativeAge]).
 */
fun formatRelativeAge(nowMs: Long, thenMs: Long): String {
    val delta = nowMs - thenMs
    if (delta < 60_000) return "now"
    val minutes = delta / 60_000
    if (minutes < 60) return "${minutes}m"
    val hours = minutes / 60
    if (hours < 24) return "${hours}h"
    val days = hours / 24
    if (days < 7) return "${days}d"
    val weeks = days / 7
    if (weeks < 5) return "${weeks}w"
    val months = days / 30
    if (months < 12) return "${months}mo"
    return "${days / 365}y"
}

/** [formatRelativeAge] against the current clock, with "now" localized. */
@Composable
fun localizedRelativeAge(thenMs: Long): String {
    val raw = formatRelativeAge(System.currentTimeMillis(), thenMs)
    return if (raw == "now") stringResource(R.string.sessions_age_now) else raw
}
