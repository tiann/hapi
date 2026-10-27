package app.hapi.companion.feature.chat.share

import java.time.ZoneOffset
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ShareTurnMetadataTest {

    private fun info(
        flavor: String? = "codex",
        machineLabel: String? = "MacBook",
        lastActiveAtMs: Long? = 1_234_567_890L,
        modelId: String? = "gpt-5.4",
        modelReasoningEffort: String? = "xhigh",
        effort: String? = null,
        serviceTier: String? = "fast",
        createdAtMs: Long? = 100L,
        updatedAtMs: Long? = 200L,
        worktreeBranch: String? = "main",
    ) = ShareTurnSessionInfo(
        title = "Session",
        flavor = flavor,
        machineLabel = machineLabel,
        lastActiveAtMs = lastActiveAtMs,
        modelId = modelId,
        modelReasoningEffort = modelReasoningEffort,
        effort = effort,
        serviceTier = serviceTier,
        createdAtMs = createdAtMs,
        updatedAtMs = updatedAtMs,
        worktreeBranch = worktreeBranch,
    )

    private val rel: (Long) -> String = { "rel:$it" }
    private val stamp: (Long) -> String = { "stamp:$it" }

    private fun labels(
        source: ShareTurnSessionInfo = info(),
        preferences: ShareTurnMetadataPreferences = ShareTurnMetadataPreferences(),
    ) = ShareTurnMetadata.buildLabels(source, preferences, rel, stamp)

    // --------------------------------------------------- default caption --

    @Test fun defaultCaptionKeepsTheFixedOrderWithoutStamps() {
        assertEquals(
            listOf("Codex", "MacBook", "rel:1234567890", "gpt-5.4", "reasoning xhigh", "fast", "main"),
            labels(),
        )
    }

    @Test fun claudeSessionsOmitReasoningAndFastTier() {
        assertEquals(
            listOf("Claude", "MacBook", "rel:1234567890", "claude-sonnet-4-6", "main"),
            labels(info(flavor = "claude", modelId = "claude-sonnet-4-6")),
        )
    }

    @Test fun captionWithoutALabelDropsTheReasoningPrefix() {
        val labels = labels(
            info(flavor = "pi", modelReasoningEffort = null, effort = "max", serviceTier = "standard"),
            ShareTurnMetadataPreferences(showLabels = false),
        )
        assertEquals(listOf("Pi", "MacBook", "rel:1234567890", "gpt-5.4", "max", "main"), labels)
    }

    // ------------------------------------------------- preference gates --

    @Test fun disabledFactsDisappearAndStampsNeedOptIn() {
        val preferences = ShareTurnMetadataPreferences(
            showLabels = false,
            agent = false,
            machine = false,
            model = false,
            reasoning = false,
            fastMode = false,
            lastActive = false,
            createdAt = true,
            updatedAt = true,
            worktree = false,
        )
        assertEquals(listOf("stamp:100", "stamp:200"), labels(preferences = preferences))
    }

    @Test fun optedInStampsSurviveAMissingMachineLabel() {
        val preferences = ShareTurnMetadataPreferences(
            agent = false, machine = true, model = false, reasoning = false,
            fastMode = false, lastActive = false, createdAt = true, updatedAt = true, worktree = false,
        )
        assertEquals(
            listOf("stamp:100", "stamp:200"),
            labels(info(machineLabel = null), preferences),
        )
    }

    @Test fun blankValuesNeverReachTheCaption() {
        val labels = labels(
            info(machineLabel = "   ", modelId = "", worktreeBranch = "  ", lastActiveAtMs = 0),
        )
        assertEquals(listOf("Codex", "reasoning xhigh", "fast"), labels)
    }

    // ------------------------------------------------------ reasoning --

    @Test fun piReportsItsOwnEffortOnlyWhenSet() {
        assertEquals("max", ShareTurnMetadata.reasoningEffortForFlavor("pi", "xhigh", "max"))
        assertNull(ShareTurnMetadata.reasoningEffortForFlavor("pi", "xhigh", null))
        assertNull(ShareTurnMetadata.reasoningEffortForFlavor("pi", "xhigh", "  "))
    }

    @Test fun codeAgentsAlwaysReportAnEffort() {
        assertEquals("high", ShareTurnMetadata.reasoningEffortForFlavor("codex", "high", null))
        assertEquals("default", ShareTurnMetadata.reasoningEffortForFlavor("codex", null, "max"))
        assertEquals("default", ShareTurnMetadata.reasoningEffortForFlavor("opencode", " ", null))
        assertNull(ShareTurnMetadata.reasoningEffortForFlavor("claude", "high", "max"))
    }

    @Test fun reasoningLabelPrefixFollowsTheLabelSwitch() {
        assertEquals("reasoning low", ShareTurnMetadata.formatReasoningLabel("low", showLabels = true))
        assertEquals("low", ShareTurnMetadata.formatReasoningLabel("low", showLabels = false))
    }

    // ------------------------------------------------------ fast tier --

    @Test fun acceleratedTiersMatchCaseInsensitively() {
        assertTrue(ShareTurnMetadata.isFastServiceTier("fast"))
        assertTrue(ShareTurnMetadata.isFastServiceTier("FAST"))
        assertTrue(ShareTurnMetadata.isFastServiceTier(" priority "))
        assertFalse(ShareTurnMetadata.isFastServiceTier("standard"))
        assertFalse(ShareTurnMetadata.isFastServiceTier("faster"))
        assertFalse(ShareTurnMetadata.isFastServiceTier(null))
    }

    @Test fun fastTierOnlyAppliesToCodexSessions() {
        assertTrue(labels().contains("fast"))
        assertFalse(labels(info(flavor = "claude")).contains("fast"))
        assertFalse(labels(info(serviceTier = "standard")).contains("fast"))
    }

    // --------------------------------------------------- relative time --

    @Test fun relativeTimeBucketsFollowTheirBoundaries() {
        val now = 10_000_000_000L
        fun bucket(delta: Long) = ShareTurnMetadata.classifyRelativeTime(now, now - delta, ZoneOffset.UTC)
        assertEquals(ShareRelativeTime.JustNow, bucket(59_999))
        assertEquals(ShareRelativeTime.MinutesAgo(1), bucket(60_000))
        assertEquals(ShareRelativeTime.MinutesAgo(59), bucket(3_599_999))
        assertEquals(ShareRelativeTime.HoursAgo(1), bucket(3_600_000))
        assertEquals(ShareRelativeTime.HoursAgo(23), bucket(86_399_999))
        assertEquals(ShareRelativeTime.DaysAgo(1), bucket(86_400_000))
        assertEquals(ShareRelativeTime.DaysAgo(6), bucket(6 * 86_400_000))
        assertEquals(
            ShareRelativeTime.AbsoluteDate(2027, 1, 15),
            ShareTurnMetadata.classifyRelativeTime(
                1_800_000_000_000L + 8 * 86_400_000L,
                1_800_000_000_000L,
                ZoneOffset.UTC,
            ),
        )
        assertNull(ShareTurnMetadata.classifyRelativeTime(now, 0))
        assertNull(ShareTurnMetadata.classifyRelativeTime(now, -5))
    }

    @Test fun absoluteDatesRenderZeroPadded() {
        assertEquals("2026/08/02", ShareTurnMetadata.formatAbsoluteDate(ShareRelativeTime.AbsoluteDate(2026, 8, 2)))
    }

    @Test fun timestampsRenderWithMonthNameAndClockTime() {
        assertEquals(
            "Jan 15, 2027, 08:00",
            ShareTurnMetadata.formatTimestamp(1_800_000_000_000L, ZoneOffset.UTC, Locale.ENGLISH),
        )
    }
}
