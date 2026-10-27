package app.hapi.companion.feature.chat

import app.hapi.protocol.chat.LatestUsage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ContextUsageTest {

    // ----------------------------------------------------- formatTokenCount --

    @Test fun tokenCountStaysPlainBelowOneThousand() {
        assertEquals("0", ContextUsage.formatTokenCount(0.0))
        assertEquals("86", ContextUsage.formatTokenCount(86.0))
        assertEquals("999", ContextUsage.formatTokenCount(999.0))
    }

    @Test fun tokenCountUsesWholeKFromOneThousand() {
        assertEquals("1k", ContextUsage.formatTokenCount(1_000.0))
        assertEquals("90k", ContextUsage.formatTokenCount(90_000.0))
        assertEquals("168k", ContextUsage.formatTokenCount(168_400.0))
        assertEquals("258k", ContextUsage.formatTokenCount(258_400.0))
        // Still the k branch right below 1M — rounding may reach 1000k.
        assertEquals("1000k", ContextUsage.formatTokenCount(999_999.0))
    }

    @Test fun tokenCountUsesOneDecimalMFromOneMillion() {
        assertEquals("1.0M", ContextUsage.formatTokenCount(1_000_000.0))
        assertEquals("1.1M", ContextUsage.formatTokenCount(1_050_000.0))
        assertEquals("2.5M", ContextUsage.formatTokenCount(2_500_000.0))
    }

    // -------------------------------------------------- contextPercentages --

    @Test fun percentagesRoundAndComplementToHundred() {
        assertEquals(35 to 65, ContextUsage.contextPercentages(90_000.0, 258_400.0))
        // Mid-point (34.5) rounds up; the complement comes off the same
        // rounded value so the pair never tears apart.
        assertEquals(35 to 65, ContextUsage.contextPercentages(69.0, 200.0))
        assertEquals(0 to 100, ContextUsage.contextPercentages(0.0, 190_000.0))
    }

    @Test fun percentagesClampWhenTheContextExceedsTheWindow() {
        assertEquals(100 to 0, ContextUsage.contextPercentages(300_000.0, 200_000.0))
    }

    // ----------------------------------------------------------- warning --

    @Test fun warningBandsFollowTheRawUsedRatio() {
        assertEquals(ContextUsageWarning.NORMAL, ContextUsage.warning(69_000.0, 100_000.0))
        // 69.999% is below the 70 threshold because the ratio is unrounded.
        assertEquals(ContextUsageWarning.NORMAL, ContextUsage.warning(69_999.0, 100_000.0))
        assertEquals(ContextUsageWarning.ELEVATED, ContextUsage.warning(70_000.0, 100_000.0))
        assertEquals(ContextUsageWarning.ELEVATED, ContextUsage.warning(89_000.0, 100_000.0))
        // 89.999% is still amber — only the raw 90% mark turns red.
        assertEquals(ContextUsageWarning.ELEVATED, ContextUsage.warning(89_999.0, 100_000.0))
        assertEquals(ContextUsageWarning.CRITICAL, ContextUsage.warning(90_000.0, 100_000.0))
        assertEquals(ContextUsageWarning.CRITICAL, ContextUsage.warning(95_000.0, 100_000.0))
        assertEquals(ContextUsageWarning.CRITICAL, ContextUsage.warning(200_000.0, 100_000.0))
    }

    // ----------------------------------------------------------- details --

    @Test fun detailsWithAKnownWindowCarryEveryField() {
        val d = ContextUsage.details(contextSize = 90_000.0, maxContextSize = 258_000.0, contextCacheRead = 86_000.0)
        assertEquals("86k", d.cacheRead)
        assertEquals("90k", d.used)
        assertEquals(35, d.usedPercent)
        assertEquals("168k", d.remaining)
        assertEquals(65, d.remainingPercent)
    }

    @Test fun detailsWithoutAWindowDropPercentagesAndRemainder() {
        val d = ContextUsage.details(contextSize = 90_000.0, maxContextSize = null, contextCacheRead = 86_000.0)
        assertEquals("86k", d.cacheRead)
        assertEquals("90k", d.used)
        assertNull(d.usedPercent)
        assertNull(d.remaining)
        assertNull(d.remainingPercent)
    }

    @Test fun detailsTreatZeroAndNullWindowsTheSame() {
        val zero = ContextUsage.details(90_000.0, 0.0, null)
        val absent = ContextUsage.details(90_000.0, null, null)
        assertEquals(absent, zero)
    }

    @Test fun detailsHideCacheReadUnlessPositive() {
        assertNull(ContextUsage.details(90_000.0, 258_000.0, null).cacheRead)
        assertNull(ContextUsage.details(90_000.0, 258_000.0, 0.0).cacheRead)
        assertNull(ContextUsage.details(90_000.0, 258_000.0, -5.0).cacheRead)
        assertEquals("500", ContextUsage.details(90_000.0, 258_000.0, 500.0).cacheRead)
    }

    @Test fun detailsClampTheRemainingCountAtZero() {
        val d = ContextUsage.details(contextSize = 300_000.0, maxContextSize = 258_000.0, contextCacheRead = null)
        assertEquals("0", d.remaining)
        assertEquals(100, d.usedPercent)
        assertEquals(0, d.remainingPercent)
    }

    // ------------------------------------------------- contextBudgetTokens --

    @Test fun codexBudgetIgnoresTheModel() {
        assertEquals(248_400.0, ContextUsage.contextBudgetTokens(null, "codex"))
        assertEquals(248_400.0, ContextUsage.contextBudgetTokens("gpt-5.4", "codex"))
    }

    @Test fun piBudgetUsesTheConservativeDefault() {
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens(null, "pi"))
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("any-model", "pi"))
    }

    @Test fun claudeBudgetDefaultsWhenTheModelIsMissing() {
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens(null, "claude"))
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("", "claude"))
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("   ", "claude"))
    }

    @Test fun claudeBudgetReadsPresetAndPrefixedModelIds() {
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("sonnet", "claude"))
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("opus", "claude"))
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("claude-sonnet-4-6", "claude"))
    }

    @Test fun claudeBudgetGrowsForLargeWindowModels() {
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("sonnet[1m]", "claude"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("opus[1m]", "claude"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("fable[1m]", "claude"))
        // Fable ships the large window even under its bare shorthand id.
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("fable", "claude"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("claude-fable-5", "claude"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("claude-anything[1m]", "claude"))
    }

    @Test fun claudeBudgetRejectsForeignModelIds() {
        assertNull(ContextUsage.contextBudgetTokens("gpt-5.4", "claude"))
        assertNull(ContextUsage.contextBudgetTokens("gemini-2.5-pro", "claude"))
    }

    @Test fun cursorBudgetParsesTheEncodedWindow() {
        assertEquals(190_000.0, ContextUsage.contextBudgetTokens("provider-x [context=200k]", "cursor"))
        assertEquals(990_000.0, ContextUsage.contextBudgetTokens("provider-x [context=1000000]", "cursor"))
        assertEquals(
            190_000.0,
            ContextUsage.contextBudgetTokens("provider-x [turbo, context=200k, extra=1]", "cursor"),
        )
    }

    @Test fun cursorBudgetRequiresAContextSegment() {
        assertNull(ContextUsage.contextBudgetTokens("provider-x", "cursor"))
        assertNull(ContextUsage.contextBudgetTokens("provider-x [ctx=200k]", "cursor"))
        assertNull(ContextUsage.contextBudgetTokens("provider-x [context=0]", "cursor"))
        assertNull(ContextUsage.contextBudgetTokens("provider-x [context=]", "cursor"))
        assertNull(ContextUsage.contextBudgetTokens(null, "cursor"))
    }

    @Test fun flavorsWithoutAEstimateReturnNull() {
        assertNull(ContextUsage.contextBudgetTokens("sonnet", null))
        assertNull(ContextUsage.contextBudgetTokens("sonnet", "opencode"))
        assertNull(ContextUsage.contextBudgetTokens("sonnet", "copilot"))
        assertNull(ContextUsage.contextBudgetTokens("sonnet", "agy"))
    }

    // ---------------------------------------------------------- indicator --

    private fun usage(
        contextSize: Double,
        contextWindow: Double? = null,
        model: String? = null,
        cacheRead: Double = 0.0,
    ) = LatestUsage(
        inputTokens = 0.0,
        outputTokens = 0.0,
        cacheCreation = 0.0,
        cacheRead = cacheRead,
        contextSize = contextSize,
        contextWindow = contextWindow,
        model = model,
        timestamp = 0L,
    )

    @Test fun indicatorStaysHiddenUntilUsageExists() {
        assertNull(ContextUsage.indicator(usage = null, sessionModel = "sonnet", flavor = "claude"))
    }

    @Test fun indicatorPrefersTheReportedWindowOverAnyEstimate() {
        val i = ContextUsage.indicator(usage(90_000.0, contextWindow = 258_400.0), "gpt-5.4", "claude")
        assertEquals("90k", i?.used)
        assertEquals("258k", i?.budget)
        assertEquals(35, i?.usedPercent)
        assertEquals(65, i?.remainingPercent)
        assertEquals(ContextUsageWarning.NORMAL, i?.warning)
    }

    @Test fun indicatorFallsBackToTheFlavorModelEstimate() {
        // No window on the usage, no model anywhere: the flavor default applies.
        val defaultWindow = ContextUsage.indicator(usage(90_000.0), null, "claude")
        assertEquals("190k", defaultWindow?.budget)
        assertEquals(47, defaultWindow?.usedPercent)
        assertEquals(53, defaultWindow?.remainingPercent)
        assertEquals(ContextUsageWarning.NORMAL, defaultWindow?.warning)

        // The usage model wins over the session model when both exist.
        val usageModelWins = ContextUsage.indicator(usage(90_000.0, model = "sonnet[1m]"), "gpt-5.4", "claude")
        assertEquals("990k", usageModelWins?.budget)

        // Without a usage model the session model feeds the estimate.
        val sessionModelUsed = ContextUsage.indicator(usage(90_000.0, model = null), "sonnet[1m]", "claude")
        assertEquals("990k", sessionModelUsed?.budget)
    }

    @Test fun indicatorShowsOnlyTheSizeWhenNoEstimateExists() {
        val i = ContextUsage.indicator(usage(90_000.0, model = "gpt-5.4"), "gpt-5.4", "claude")
        assertEquals("90k", i?.used)
        assertNull(i?.budget)
        assertNull(i?.usedPercent)
        assertNull(i?.remainingPercent)
        assertEquals(ContextUsageWarning.NORMAL, i?.warning)
    }

    @Test fun indicatorWithoutAFlavorShowsOnlyTheSize() {
        val i = ContextUsage.indicator(usage(120_000.0), "sonnet", null)
        assertEquals("120k", i?.used)
        assertNull(i?.budget)
    }

    @Test fun indicatorEscalatesAsTheWindowFills() {
        fun band(size: Double): ContextUsageWarning? =
            ContextUsage.indicator(usage(size), null, "claude")?.warning

        assertEquals(ContextUsageWarning.NORMAL, band(100_000.0))
        assertEquals(ContextUsageWarning.ELEVATED, band(140_000.0))
        assertEquals(ContextUsageWarning.CRITICAL, band(175_000.0))
    }

    @Test fun indicatorCarriesRawNumbersForTheLabel() {
        // Codex-style: explicit window straight from the usage signal.
        val i = ContextUsage.indicator(usage(90_000.0, contextWindow = 258_400.0, cacheRead = 86_000.0), null, null)
        assertEquals("258k", i?.budget)
        assertEquals(65, i?.remainingPercent)
        assertEquals("90k", i?.used)
    }
}
