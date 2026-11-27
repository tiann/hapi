package app.hapi.protocol.chat

import java.time.ZoneOffset
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

class OutlineTest {

    private fun userBlock(
        id: String,
        text: String,
        createdAt: Long,
        invokedAt: Long? = 2500,
        status: String? = "sent",
    ): UserTextBlock = UserTextBlock(
        id = id,
        localId = null,
        createdAt = createdAt,
        invokedAt = invokedAt,
        text = text,
        attachments = null,
        status = status,
        originalText = null,
        meta = null,
    )

    private fun eventBlock(id: String, type: String, createdAt: Long): AgentEventBlock =
        AgentEventBlock(
            id = id,
            createdAt = createdAt,
            invokedAt = null,
            model = null,
            event = AgentEvent.of(buildJsonObject { put("type", type) }),
            meta = null,
        )

    @Test
    fun createsOutlineItemsFromUserMessages() {
        val items = buildConversationOutline(
            listOf(userBlock("m1", "Implement the outline panel", 1000)),
        )
        assertEquals(
            listOf(
                ConversationOutlineItem(
                    id = "outline:user-text:m1",
                    targetBlockId = "m1",
                    label = "Implement the outline panel",
                    createdAt = 1000,
                ),
            ),
            items,
        )
    }

    @Test
    fun ignoresTitleAndSummaryEvents() {
        val items = buildConversationOutline(
            listOf(
                eventBlock("e1", "title-changed", 1000),
                eventBlock("e2", "message", 2000),
                eventBlock("e3", "ready", 3000),
            ),
        )
        assertTrue(items.isEmpty(), "event blocks must never produce outline entries")
    }

    @Test
    fun whitespaceOnlyTextFallsBackToEmptyLabel() {
        val items = buildConversationOutline(listOf(userBlock("empty", " \n\t ", 1000)))
        assertEquals(EMPTY_OUTLINE_LABEL, items.single().label)
    }

    @Test
    fun longLabelsCollapseThenTruncateWithThreeDots() {
        assertEquals("a a a a a a a a a...", truncateOutlineLabel("a ".repeat(80), 20))
    }

    @Test
    fun truncationNeverExceedsTheCapAndTrimsBeforeTheDots() {
        val label96 = "x".repeat(96)
        val label97 = "x".repeat(97)
        assertEquals(label96, truncateOutlineLabel(label96))
        assertEquals("${"x".repeat(93)}...", truncateOutlineLabel(label97))
        // Trailing whitespace at the cut is dropped, so the ellipsis starts
        // on a word character and the result stays under the cap.
        val spaced = ("word ".repeat(40)).trimEnd()
        val truncated = truncateOutlineLabel(spaced, 24)
        assertTrue(truncated.length <= 24)
        assertTrue(truncated.endsWith("..."))
        assertTrue(!truncated.dropLast(3).endsWith(' '))
        // A cut landing right after a word drops the dangling space.
        assertEquals("word word word...", truncateOutlineLabel(spaced, 18))
        // A cap smaller than the dots keeps exactly the dots.
        assertEquals("...", truncateOutlineLabel("abcdef", 2))
    }

    @Test
    fun collapseWhitespaceMergesRunsAndDropsEdges() {
        assertEquals("a b c", collapseOutlineWhitespace("  a\t b\n\nc  "))
        assertEquals("", collapseOutlineWhitespace(" \n\t "))
        // The full-width space and non-breaking space are whitespace here too.
        assertEquals("a b", collapseOutlineWhitespace("a　 b"))
    }

    @Test
    fun filtersQueuedUserMessagesThatAreNotYetLocatable() {
        val items = buildConversationOutline(
            listOf(
                userBlock("queued", "Queued prompt", 1000, invokedAt = null, status = "queued"),
                userBlock("sent", "Visible prompt", 2000, invokedAt = 2500, status = "sent"),
            ),
        )
        assertEquals(listOf("outline:user-text:sent"), items.map { it.id })
    }

    @Test
    fun failedSendsStayAddressableEvenWithoutInvokeTime() {
        val items = buildConversationOutline(
            listOf(
                userBlock("failed", "Broken prompt", 1000, invokedAt = null, status = "failed"),
                userBlock("sending", "In flight", 2000, invokedAt = null, status = "sending"),
            ),
        )
        assertEquals(listOf("outline:user-text:failed"), items.map { it.id })
    }

    @Test
    fun keepsBlockOrderStable() {
        val items = buildConversationOutline(
            listOf(
                userBlock("first", "First", 1000),
                eventBlock("summary", "message", 900),
                userBlock("second", "Second", 1100),
            ),
        )
        assertEquals(
            listOf("outline:user-text:first", "outline:user-text:second"),
            items.map { it.id },
        )
    }

    private fun epochMs(
        year: Int,
        month: Int,
        day: Int,
        hour: Int,
        minute: Int,
    ): Long = java.time.LocalDateTime.of(year, month, day, hour, minute)
        .toInstant(ZoneOffset.UTC)
        .toEpochMilli()

    @Test
    fun timestampIsTimeOnlyOnTheCurrentDay() {
        val now = epochMs(2026, 10, 27, 13, 0)
        assertEquals(
            "14:05",
            formatOutlineTimestamp(
                epochMs(2026, 10, 27, 14, 5),
                "en",
                nowEpochMs = now,
                zone = ZoneOffset.UTC,
            ),
        )
    }

    @Test
    fun timestampShapesPerLanguageWithPaddedMonthAndDay() {
        val now = epochMs(2026, 10, 27, 13, 0)
        val sameYearOtherDay = epochMs(2026, 3, 9, 14, 5)
        val otherYear = epochMs(2024, 3, 9, 14, 5)

        assertEquals("03/09 14:05", formatOutlineTimestamp(sameYearOtherDay, "en", now, ZoneOffset.UTC))
        assertEquals("2024/03/09 14:05", formatOutlineTimestamp(otherYear, "en", now, ZoneOffset.UTC))
        assertEquals("03月09日 14:05", formatOutlineTimestamp(sameYearOtherDay, "zh-CN", now, ZoneOffset.UTC))
        assertEquals("2024年03月09日 14:05", formatOutlineTimestamp(otherYear, "zh-Hans-CN", now, ZoneOffset.UTC))
        assertEquals("09.03 14:05", formatOutlineTimestamp(sameYearOtherDay, "ru", now, ZoneOffset.UTC))
        assertEquals("09.03.2024 14:05", formatOutlineTimestamp(otherYear, "ru-RU", now, ZoneOffset.UTC))
    }
}
