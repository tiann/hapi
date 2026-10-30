package app.hapi.companion.feature.chat

import app.hapi.protocol.chat.LatestUsage
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

/** Warning band for the context indicator; rises as the session context fills. */
enum class ContextUsageWarning {
    /** Comfortable headroom — neutral hint color. */
    NORMAL,

    /** At or past the caution threshold — amber. */
    ELEVATED,

    /** At or past the critical threshold — red. */
    CRITICAL,
}

/** Context numbers for the composer status strip, pre-formatted for display. */
data class ContextUsageIndicator(
    /** Abbreviated current context size, e.g. `90k`. */
    val used: String,
    /** Abbreviated window budget, e.g. `258k`; null when the window is unknown. */
    val budget: String?,
    /** Share of the window in use (0..100); null when the window is unknown. */
    val usedPercent: Int?,
    /** Complementary share still free; null when the window is unknown. */
    val remainingPercent: Int?,
    /** Color band for the indicator; stays NORMAL while the window is unknown. */
    val warning: ContextUsageWarning = ContextUsageWarning.NORMAL,
)

/** Full context readout, including the pieces only detail surfaces use. */
data class ContextUsageDetails(
    /** Abbreviated cache-read size; null when absent, zero or negative. */
    val cacheRead: String?,
    /** Abbreviated current context size. */
    val used: String,
    /** Share of the window in use; null when the window is unknown. */
    val usedPercent: Int?,
    /** Abbreviated free token count; null when the window is unknown. */
    val remaining: String?,
    /** Complementary share still free; null when the window is unknown. */
    val remainingPercent: Int?,
)

/**
 * Context-remaining math for the composer status strip.
 *
 * Window resolution: an explicit window reported alongside the usage signal
 * wins; otherwise a per-flavor default (minus a fixed headroom) estimates it.
 * Sessions whose flavor/model yields no estimate fall back to a size-only
 * readout with no percentages and no warning color.
 */
object ContextUsage {
    /** Used share at which the indicator turns amber. */
    const val WARNING_THRESHOLD_PERCENT = 70.0

    /** Used share at which the indicator turns red. */
    const val DANGER_THRESHOLD_PERCENT = 90.0

    /**
     * Tokens held back from every estimated window: system prompts, tool
     * definitions and other hidden consumers eat into the nominal size, so
     * the estimate stays conservative near the limit. An explicit window
     * from the usage signal is used verbatim.
     */
    private const val HEADROOM_TOKENS = 10_000.0

    private const val DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000.0
    private const val LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS = 1_000_000.0

    /** Codex default; matches the window reported by token-count events. */
    private const val DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS = 258_400.0

    /** Conservative default for multi-provider sessions. */
    private const val DEFAULT_PI_CONTEXT_WINDOW_TOKENS = 200_000.0

    /** Shorthand model ids that resolve to a Claude window. */
    private val CLAUDE_MODEL_PRESETS =
        setOf("sonnet", "sonnet[1m]", "opus", "opus[1m]", "fable", "fable[1m]")

    private val CURSOR_MODEL_SEGMENT = Regex("\\[([^]]+)]")
    private val LEADING_DIGITS = Regex("(\\d+)")

    /** Abbreviate a token count: plain below 1k, whole `k`, one-decimal `M`. */
    fun formatTokenCount(value: Double): String = when {
        value >= 1_000_000 -> String.format(Locale.US, "%.1fM", value / 1_000_000.0)
        value >= 1_000 -> Math.round(value / 1_000.0).toString() + "k"
        value % 1.0 == 0.0 -> value.toLong().toString()
        else -> value.toString()
    }

    /**
     * Window shares for [contextSize] of [maxContextSize]: the used share
     * rounded and clamped to 0..100, plus its complement. Both derive from
     * the same rounded value, so they always sum to exactly 100.
     */
    fun contextPercentages(contextSize: Double, maxContextSize: Double): Pair<Int, Int> {
        val usedPercent = ((contextSize / maxContextSize) * 100).roundToInt().coerceIn(0, 100)
        return usedPercent to 100 - usedPercent
    }

    /**
     * Warning band from the raw used ratio (unrounded, unclamped): red at
     * [DANGER_THRESHOLD_PERCENT] and above, amber from [WARNING_THRESHOLD_PERCENT],
     * neutral below. Only meaningful with a known window.
     */
    fun warning(contextSize: Double, maxContextSize: Double): ContextUsageWarning {
        val percentUsed = (contextSize / maxContextSize) * 100
        return when {
            percentUsed >= DANGER_THRESHOLD_PERCENT -> ContextUsageWarning.CRITICAL
            percentUsed >= WARNING_THRESHOLD_PERCENT -> ContextUsageWarning.ELEVATED
            else -> ContextUsageWarning.NORMAL
        }
    }

    /**
     * Complete readout for the current context. Without a known window the
     * percentages and remaining count stay null; the cache-read figure only
     * appears when it is a positive number.
     */
    fun details(
        contextSize: Double,
        maxContextSize: Double?,
        contextCacheRead: Double?,
    ): ContextUsageDetails {
        val cacheRead = contextCacheRead?.takeIf { it > 0 }?.let(::formatTokenCount)
        val window = if (maxContextSize.isKnownWindow()) maxContextSize else null
        if (window == null) {
            return ContextUsageDetails(
                cacheRead = cacheRead,
                used = formatTokenCount(contextSize),
                usedPercent = null,
                remaining = null,
                remainingPercent = null,
            )
        }
        val (usedPercent, remainingPercent) = contextPercentages(contextSize, window)
        return ContextUsageDetails(
            cacheRead = cacheRead,
            used = formatTokenCount(contextSize),
            usedPercent = usedPercent,
            remaining = formatTokenCount(max(0.0, window - contextSize)),
            remainingPercent = remainingPercent,
        )
    }

    /**
     * Estimated usable window for a session, or null when the flavor/model
     * combination carries no estimate (the readout then hides percentages).
     * Every estimate subtracts [HEADROOM_TOKENS], floored at one token.
     */
    fun contextBudgetTokens(model: String?, flavor: String?): Double? = when (flavor) {
        "codex" -> usableWindow(DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS)
        "pi" -> usableWindow(DEFAULT_PI_CONTEXT_WINDOW_TOKENS)
        "cursor" -> model?.trim()
            ?.let(::parseCursorWireContextWindow)
            ?.let(::usableWindow)
        "claude" -> claudeContextWindow(model?.trim())?.let(::usableWindow)
        else -> null
    }

    /**
     * Indicator state for the composer strip: null until the thread has any
     * usage signal. The window prefers the value reported alongside the
     * usage, then falls back to the flavor/model estimate — the model on the
     * usage message first, the session's model second.
     */
    fun indicator(
        usage: LatestUsage?,
        sessionModel: String?,
        flavor: String?,
    ): ContextUsageIndicator? {
        if (usage == null) return null
        val window = usage.contextWindow
            ?: contextBudgetTokens(usage.model ?: sessionModel, flavor)
        return indicator(
            contextSize = usage.contextSize,
            maxContextSize = window,
            contextCacheRead = usage.cacheRead,
        )
    }

    /** Indicator state from raw numbers; an unknown window keeps the readout size-only. */
    fun indicator(
        contextSize: Double,
        maxContextSize: Double?,
        contextCacheRead: Double? = null,
    ): ContextUsageIndicator {
        val readout = details(contextSize, maxContextSize, contextCacheRead)
        val window = if (maxContextSize.isKnownWindow()) maxContextSize else null
        return ContextUsageIndicator(
            used = readout.used,
            budget = window?.let(::formatTokenCount),
            usedPercent = readout.usedPercent,
            remainingPercent = readout.remainingPercent,
            warning = window?.let { warning(contextSize, it) } ?: ContextUsageWarning.NORMAL,
        )
    }

    /** A window counts as known when present, numeric and non-zero. */
    private fun Double?.isKnownWindow(): Boolean {
        val value = this ?: return false
        return !value.isNaN() && value != 0.0
    }

    private fun usableWindow(windowTokens: Double): Double = max(1.0, windowTokens - HEADROOM_TOKENS)

    private fun claudeContextWindow(model: String?): Double? {
        if (model.isNullOrEmpty()) return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        if (model !in CLAUDE_MODEL_PRESETS && !model.startsWith("claude-")) return null
        val largeWindow = model.endsWith("[1m]") || isFableModel(model)
        return if (largeWindow) LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS else DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
    }

    /** Fable models ship a large window even under their bare shorthand id. */
    private fun isFableModel(model: String): Boolean =
        model == "fable" || model == "fable[1m]" || model.startsWith("claude-fable")

    /**
     * Window encoded inside a model name, e.g. `provider-x [context=200k]`.
     * Returns null unless a positive `context=` segment is present.
     */
    private fun parseCursorWireContextWindow(model: String): Double? {
        val inner = CURSOR_MODEL_SEGMENT.find(model)?.groupValues?.get(1) ?: return null
        for (segment in inner.split(',')) {
            val part = segment.trim()
            val eq = part.indexOf('=')
            if (eq == -1 || part.substring(0, eq).trim() != "context") continue
            val raw = part.substring(eq + 1).trim().lowercase(Locale.ROOT)
            val digits = LEADING_DIGITS.find(raw)?.groupValues?.get(1) ?: return null
            val value = digits.toLongOrNull() ?: return null
            if (value <= 0) return null
            return (if (raw.endsWith("k")) value * 1_000 else value).toDouble()
        }
        return null
    }
}
