package app.hapi.companion.feature.chat.share

import app.hapi.protocol.catalog.Flavors
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Which session facts the shared card's header mentions. The defaults mirror
 * the long-standing header configuration: everything current except the two
 * creation/modification stamps.
 */
data class ShareTurnMetadataPreferences(
    val showLabels: Boolean = true,
    val agent: Boolean = true,
    val machine: Boolean = true,
    val model: Boolean = true,
    val reasoning: Boolean = true,
    val fastMode: Boolean = true,
    val lastActive: Boolean = true,
    val createdAt: Boolean = false,
    val updatedAt: Boolean = false,
    val worktree: Boolean = true,
)

/**
 * Session facts a shared card can cite. Every field is optional; missing
 * facts simply drop out of the header line.
 */
data class ShareTurnSessionInfo(
    val title: String,
    val flavor: String? = null,
    val machineLabel: String? = null,
    val lastActiveAtMs: Long? = null,
    val modelId: String? = null,
    val modelReasoningEffort: String? = null,
    val effort: String? = null,
    val serviceTier: String? = null,
    val createdAtMs: Long? = null,
    val updatedAtMs: Long? = null,
    val worktreeBranch: String? = null,
)

/** Age bucket for the "last active" header fact. */
sealed interface ShareRelativeTime {
    data object JustNow : ShareRelativeTime
    data class MinutesAgo(val minutes: Long) : ShareRelativeTime
    data class HoursAgo(val hours: Long) : ShareRelativeTime
    data class DaysAgo(val days: Long) : ShareRelativeTime
    data class AbsoluteDate(val year: Int, val month: Int, val day: Int) : ShareRelativeTime
}

/**
 * Header metadata for a shared card: turns session facts into the ordered
 * caption line under the session title. A fact appears when its switch is
 * on and its value exists; the fixed order is agent, machine, last active,
 * model, reasoning, fast mode, created, updated, worktree.
 */
object ShareTurnMetadata {

    /** Service tiers that count as accelerated execution. */
    private val FAST_SERVICE_TIER = Regex("^(fast|priority)$", RegexOption.IGNORE_CASE)

    /** Bucket a "last active" timestamp into its display form. */
    fun classifyRelativeTime(
        nowMs: Long,
        thenMs: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): ShareRelativeTime? {
        if (thenMs <= 0) return null
        val delta = nowMs - thenMs
        return when {
            delta < 60_000 -> ShareRelativeTime.JustNow
            delta < 3_600_000 -> ShareRelativeTime.MinutesAgo(delta / 60_000)
            delta < 86_400_000 -> ShareRelativeTime.HoursAgo(delta / 3_600_000)
            delta < 7 * 86_400_000 -> ShareRelativeTime.DaysAgo(delta / 86_400_000)
            else -> {
                val date = Instant.ofEpochMilli(thenMs).atZone(zone)
                ShareRelativeTime.AbsoluteDate(date.year, date.monthValue, date.dayOfMonth)
            }
        }
    }

    /** Numeric calendar date as `YYYY/MM/DD` (zone-independent input). */
    fun formatAbsoluteDate(value: ShareRelativeTime.AbsoluteDate): String =
        "%04d/%02d/%02d".format(Locale.US, value.year, value.month, value.day)

    /** Timestamp stamp form `Aug 2, 2026, 10:00` for created/updated facts. */
    fun formatTimestamp(epochMs: Long, zone: ZoneId, locale: Locale): String =
        DateTimeFormatter.ofPattern("MMM d, yyyy, HH:mm", locale)
            .format(Instant.ofEpochMilli(epochMs).atZone(zone))

    /** Accelerated-tier check: `fast` / `priority`, case-insensitive. */
    fun isFastServiceTier(tier: String?): Boolean =
        tier != null && FAST_SERVICE_TIER.matches(tier.trim())

    /**
     * Reasoning effort a flavor reports: code agents always have one
     * (unset becomes `default`); pi reports its own `effort` only when set;
     * other flavors report none.
     */
    fun reasoningEffortForFlavor(
        flavor: String?,
        modelReasoningEffort: String?,
        effort: String?,
    ): String? = when (flavor) {
        "codex", "opencode" -> modelReasoningEffort?.trim()?.takeIf { it.isNotEmpty() } ?: "default"
        "pi" -> effort?.trim()?.takeIf { it.isNotEmpty() }
        else -> null
    }

    /** `reasoning X` with the label, bare `X` without. */
    fun formatReasoningLabel(effort: String, showLabels: Boolean): String =
        if (showLabels) "reasoning $effort" else effort

    /**
     * Caption entries under the card title, in display order. Time formats
     * arrive as callbacks so the caller resolves localized wording while
     * this ordering/filtering logic stays testable.
     */
    fun buildLabels(
        info: ShareTurnSessionInfo,
        preferences: ShareTurnMetadataPreferences = ShareTurnMetadataPreferences(),
        formatRelativeTime: (Long) -> String,
        formatTimestamp: (Long) -> String,
    ): List<String> = buildList {
        val flavor = info.flavor?.trim()?.takeIf { it.isNotEmpty() }
        if (preferences.agent) {
            flavor?.let { add(Flavors.label(it)) }
        }
        if (preferences.machine) {
            info.machineLabel?.trim()?.takeIf { it.isNotEmpty() }?.let(::add)
        }
        if (preferences.lastActive) {
            info.lastActiveAtMs?.takeIf { it > 0 }?.let { add(formatRelativeTime(it)) }
        }
        if (preferences.model) {
            info.modelId?.trim()?.takeIf { it.isNotEmpty() }?.let(::add)
        }
        if (preferences.reasoning) {
            reasoningEffortForFlavor(flavor, info.modelReasoningEffort, info.effort)
                ?.let { add(formatReasoningLabel(it, preferences.showLabels)) }
        }
        if (preferences.fastMode) {
            if (flavor == "codex" && isFastServiceTier(info.serviceTier)) add("fast")
        }
        if (preferences.createdAt) {
            info.createdAtMs?.takeIf { it > 0 }?.let { add(formatTimestamp(it)) }
        }
        if (preferences.updatedAt) {
            info.updatedAtMs?.takeIf { it > 0 }?.let { add(formatTimestamp(it)) }
        }
        if (preferences.worktree) {
            info.worktreeBranch?.trim()?.takeIf { it.isNotEmpty() }?.let(::add)
        }
    }
}
