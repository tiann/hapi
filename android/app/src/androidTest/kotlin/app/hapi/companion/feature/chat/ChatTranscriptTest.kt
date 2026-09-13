package app.hapi.companion.feature.chat

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.height
import androidx.compose.animation.core.tween
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Composer
import androidx.compose.runtime.CompositionTracer
import androidx.compose.runtime.InternalComposeTracingApi
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.data.store.ChatHistoryPagingState
import app.hapi.protocol.chat.AgentTextBlock
import app.hapi.protocol.chat.AgentReasoningBlock
import app.hapi.companion.ui.markdown.MarkdownRenderCache
import app.hapi.companion.ui.markdown.LocalMarkdownRenderCache
import app.hapi.protocol.chat.VisibleChatBlock
import app.hapi.protocol.chat.ToolGroupBlock
import app.hapi.protocol.chat.ToolGroupingOptions
import app.hapi.protocol.chat.buildVisibleChatBlocks
import app.hapi.companion.feature.chat.blocks.previewToolCall
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ChatTranscriptTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var list: LazyListState
    private lateinit var scope: CoroutineScope
    private val layoutVersion = AtomicLong(-1)
    private val needsOlder = AtomicReference(false)
    private val viewportReports = AtomicReference<List<Boolean>>(emptyList())
    private val shown = mutableStateOf(true)
    private val jumpToken = mutableStateOf(0L)
    private val state = mutableStateOf(makeState(emptyList()))
    private val markdown = MarkdownRenderCache()
    private val viewportHeight = mutableStateOf<Dp?>(null)

    @OptIn(InternalComposeTracingApi::class)
    @Test fun scrollingDoesNotRecomposeTheTranscriptOrRepeatUnchangedDemand() {
        val compositions = AtomicLong()
        Composer.setTracer(object : CompositionTracer {
            override fun isTraceInProgress() = true
            override fun traceEventEnd() = Unit
            override fun traceEventStart(key: Int, dirty1: Int, dirty2: Int, info: String) {
                if (info.startsWith("app.hapi.companion.feature.chat.ChatTranscript (")) compositions.incrementAndGet()
            }
        })
        try {
            mount(rows(0..799))
            assertTrue("Tracer must observe the real transcript, not a test wrapper", compositions.get() > 0)
            browse(350, 37)
            val before = anchor()
            compositions.set(0)
            viewportReports.set(emptyList())
            compose.runOnIdle { scope.launch { list.animateScrollBy(1200f, tween(600)) } }
            compose.waitForIdle()
            assertTrue("The performance probe must actually cross rows", anchor().first != before.first)
            val count = compositions.get()
            android.util.Log.i("HapiScrollPerf", "800-row scroll: transcript compositions=$count, viewport reports=${viewportReports.get().size}")
            assertTrue("Transcript recomposed $count times during a history scroll", count <= 2)
            assertTrue("Unchanged viewport demand was republished ${viewportReports.get().size} times", viewportReports.get().size <= 1)
        } finally {
            Composer.setTracer(null)
        }
    }

    private fun rows(range: IntRange): List<VisibleChatBlock> = range.map {
        AgentTextBlock(
            id = "message-$it", localId = null, createdAt = it.toLong(), invokedAt = it.toLong(),
            text = "Message $it\n\n" + ("Variable-height history content. ".repeat(1 + it % 5)), meta = null,
        )
    }

    private fun makeState(blocks: List<VisibleChatBlock>) = ChatUiState(
        sessionId = "layout-test",
        header = ChatHeaderUi("Layout test", active = false, thinking = false, subtitle = null),
        flavor = null, basePath = null, blocks = blocks, permissionOverrides = emptyMap(),
        hasMore = true, isLoadingOlder = false, isSyncingTail = false, isInitialLoading = false,
        loadFailed = false, warning = null, tailRevision = 0,
    )

    private fun mount(blocks: List<VisibleChatBlock>, restoration: StateRestorationTester? = null) {
        markdown.prepare(blocks.mapNotNull { (it as? AgentTextBlock)?.text ?: (it as? AgentReasoningBlock)?.text }.toSet())
        state.value = makeState(blocks)
        val content: @Composable () -> Unit = {
            val savedScreens = rememberSaveableStateHolder()
            if (shown.value) savedScreens.SaveableStateProvider(state.value.sessionId) {
                list = rememberLazyListState()
                scope = rememberCoroutineScope()
                HapiTheme {
                    CompositionLocalProvider(LocalMarkdownRenderCache provides markdown) {
                        ChatTranscript(
                            state = state.value, paging = ChatHistoryPagingState(), jumpToken = jumpToken.value,
                            jumpingLatest = false, onViewport = { follows, needs ->
                                viewportReports.set(viewportReports.get() + follows)
                                needsOlder.set(needs)
                            },
                            onLayout = { version, _ -> layoutVersion.set(version) },
                            onRetryHistory = {}, onJumpToLatest = {}, listState = list,
                            modifier = viewportHeight.value?.let { Modifier.height(it) } ?: Modifier,
                        )
                    }
                }
            }
        }
        if (restoration == null) compose.setContent(content) else restoration.setContent(content)
        compose.waitUntil(10_000) { layoutVersion.get() == 0L }
        compose.waitForIdle()
    }

    private fun browse(index: Int, offset: Int) {
        compose.onNodeWithTag("chat-transcript").performTouchInput { swipeDown(durationMillis = 400) }
        compose.runOnIdle { scope.launch { list.scrollToItem(index, offset) } }
        compose.waitForIdle()
    }

    private fun anchor(): Pair<Any, Int> = compose.runOnIdle {
        list.layoutInfo.visibleItemsInfo.first { it.key != "chat-history-control" }.let { it.key to it.offset }
    }

    @Test fun planUpdatesAndRecyclingPreserveTheReadingAnchor() {
        fun plan(text: String) = previewToolCall("proposal", "ExitPlanMode", input = mapOf("plan" to text))
        val initial = "# Visible proposal\n\nRead the plan without tapping a tool."
        markdown.prepare(setOf(initial))
        mount(rows(0..19) + plan(initial) + rows(21..79))
        browse(21, 0)
        compose.onNodeWithText("Visible proposal").assertIsDisplayed()
        val before = anchor()
        val updated = "# Revised proposal\n\n" + "More plan detail. ".repeat(100)
        markdown.prepare(setOf(updated))
        compose.runOnIdle {
            state.value = state.value.copy(blocks = rows(0..19) + plan(updated) + rows(21..79), messagesVersion = 1)
        }
        compose.waitForIdle()
        compose.onNodeWithText("Revised proposal").assertIsDisplayed()
        assertEquals(before, anchor())
        browse(60, 0)
        browse(21, 0)
        compose.onNodeWithText("Revised proposal").assertIsDisplayed()
        compose.onNodeWithText("Visible proposal").assertDoesNotExist()
    }

    @Test fun tailStillFollowsTallRowGrowthAppendsAndViewportResize() {
        mount(rows(0..39))
        fun assertFollowing() {
            compose.waitForIdle()
            compose.runOnIdle { assertTrue("Live tail must remain visible", !list.canScrollForward) }
            assertEquals(true, viewportReports.get().last())
        }
        assertFollowing()
        compose.runOnIdle {
            val last = state.value.blocks.last() as AgentTextBlock
            val text = last.text + "\n\n" + "Growing the live row beyond the viewport. ".repeat(100)
            markdown.prepare(setOf(text))
            state.value = state.value.copy(
                blocks = state.value.blocks.dropLast(1) + AgentTextBlock(
                    id = last.id, localId = null, createdAt = last.createdAt, invokedAt = last.invokedAt,
                    text = text, meta = null,
                ), messagesVersion = 1,
            )
        }
        assertFollowing()
        compose.runOnIdle { state.value = state.value.copy(blocks = state.value.blocks + rows(40..41), messagesVersion = 2) }
        assertFollowing()
        compose.runOnIdle { viewportHeight.value = 360.dp }
        assertFollowing()
    }

    private fun mountWithGroupSummary(restoration: StateRestorationTester? = null): ToolGroupBlock {
        val tools = (1..12).map { previewToolCall("group-child-$it", "Read", input = mapOf("file_path" to "file-$it.txt")) }
        val group = buildVisibleChatBlocks(tools, ToolGroupingOptions(hasMoreMessages = false))
            .filterIsInstance<ToolGroupBlock>().single()
        assertTrue(!group.defaultOpen)
        mount(rows(0..24) + group + rows(25..79), restoration)
        // Keep the preceding row outside the content-padding/spacing band.
        // Exercise a partially visible summary, not an item-boundary ambiguity.
        browse(26, 20)
        compose.onNodeWithText("12 tools").performClick()
        compose.waitForIdle()
        // Tapping a summary cannot change transcript membership or height.
        assertEquals(group.id, anchor().first)
        compose.onNodeWithTag("chat-row-group-child-1").assertDoesNotExist()
        compose.runOnIdle { assertEquals(82, list.layoutInfo.totalItemsCount) }
        return group
    }

    @Test fun navigationReturnPreservesGroupSummaryAnchor() {
        mountWithGroupSummary()
        val before = anchor()
        compose.runOnIdle { shown.value = false }
        compose.waitForIdle()
        viewportReports.set(emptyList())
        compose.runOnIdle { shown.value = true }
        assertHistoryRestored(before)
    }

    @Test fun savedInstanceStateRestoresGroupSummaryAnchor() {
        val restoration = StateRestorationTester(compose)
        mountWithGroupSummary(restoration)
        val before = anchor()
        viewportReports.set(emptyList())
        restoration.emulateSavedInstanceStateRestore()
        assertHistoryRestored(before)
    }

    @Test fun groupReappearanceNeverAddsInlineChildren() {
        val restoration = StateRestorationTester(compose)
        val group = mountWithGroupSummary(restoration)
        compose.runOnIdle {
            state.value = state.value.copy(blocks = rows(0..79), messagesVersion = 1)
        }
        compose.waitForIdle()
        restoration.emulateSavedInstanceStateRestore()
        compose.runOnIdle {
            state.value = state.value.copy(blocks = rows(0..24) + group + rows(25..79), messagesVersion = 2)
        }
        browse(26, 0)
        compose.onNodeWithTag("chat-row-${group.id}").assertIsDisplayed()
        compose.onNodeWithTag("chat-row-group-child-1").assertDoesNotExist()
        compose.runOnIdle { assertEquals(82, list.layoutInfo.totalItemsCount) }
    }

    private fun assertHistoryRestored(before: Pair<Any, Int>) {
        compose.waitForIdle()
        assertEquals(before, anchor())
        assertTrue("Restored viewport must never report tail mode", viewportReports.get().let {
            it.isNotEmpty() && it.none { follows -> follows }
        })
        compose.onNodeWithTag("chat-latest").assertIsDisplayed()
        // A genuinely new command must still work after ignoring the old one.
        compose.runOnIdle { jumpToken.value += 1 }
        compose.waitForIdle()
        compose.runOnIdle { assertTrue(!list.canScrollForward) }
        assertEquals(true, viewportReports.get().last())
    }

    @Test fun navigationReturnRestoresHistoryIntentAndDoesNotReplayConsumedJump() {
        jumpToken.value = 1
        mount(rows(0..79))
        browse(25, 37)
        val before = anchor()
        compose.runOnIdle { shown.value = false }
        compose.waitForIdle()
        viewportReports.set(emptyList())
        compose.runOnIdle { shown.value = true }
        assertHistoryRestored(before)
    }

    @Test fun savedInstanceStateRestoresReadingPositionAndConsumedJumpTogether() {
        val restoration = StateRestorationTester(compose)
        jumpToken.value = 3
        mount(rows(0..79), restoration)
        browse(25, 37)
        val before = anchor()
        viewportReports.set(emptyList())
        restoration.emulateSavedInstanceStateRestore()
        assertHistoryRestored(before)
    }

    @Test fun recreatedViewModelRebasesJumpTokensWithoutTakingOverHistory() {
        val restoration = StateRestorationTester(compose)
        jumpToken.value = 1
        mount(rows(0..79), restoration)
        browse(25, 37)
        val before = anchor()
        // A new ViewModel starts at zero, independent of saved Compose state.
        compose.runOnIdle { jumpToken.value = 0 }
        compose.waitForIdle()
        viewportReports.set(emptyList())
        restoration.emulateSavedInstanceStateRestore()
        assertHistoryRestored(before)
    }

    @Test fun prependPreservesLatestReaderPositionWithBoundedWindowTrimming() {
        mount(rows(100..179))
        browse(15, 19)
        compose.runOnIdle { scope.launch { list.scrollToItem(21, 31) } }
        compose.waitForIdle()
        val before = anchor()
        compose.runOnIdle {
            state.value = state.value.copy(
                blocks = rows(80..99) + state.value.blocks.dropLast(20),
                historyVersion = 1, messagesVersion = 1,
            )
        }
        compose.waitUntil(10_000) { layoutVersion.get() == 1L }
        compose.waitForIdle()
        val after = anchor()
        assertEquals(before.first, after.first)
        assertTrue("Extra anchor displacement: " + (after.second - before.second), kotlin.math.abs(after.second - before.second) <= 1)
    }

    @Test fun streamingAndTallRowGrowthDoNotReclaimHistory() {
        mount(rows(0..79))
        browse(25, 37)
        val before = anchor()
        compose.runOnIdle {
            val last = state.value.blocks.last() as AgentTextBlock
            state.value = state.value.copy(
                blocks = state.value.blocks.dropLast(1) + AgentTextBlock(
                    id = last.id, localId = null, createdAt = last.createdAt, invokedAt = last.invokedAt,
                    text = last.text + "\n\n" + "Streaming more content. ".repeat(100), meta = null,
                ),
                messagesVersion = 1,
            )
        }
        compose.waitForIdle()
        assertEquals(before, anchor())
        compose.runOnIdle {
            val row = state.value.blocks.first { it.stableId == before.first } as AgentTextBlock
            val text = row.text + "\n\n" + "More content in the current row. ".repeat(30)
            markdown.prepare(setOf(text))
            state.value = state.value.copy(
                blocks = state.value.blocks.map { block ->
                    if (block !== row) block else AgentTextBlock(
                        id = row.id, localId = null, createdAt = row.createdAt, invokedAt = row.invokedAt,
                        text = text, meta = null,
                    )
                }, messagesVersion = 2,
            )
        }
        compose.waitForIdle()
        assertEquals(before, anchor())
    }

    @Test fun expansionSurvivesCellRecycling() {
        val blocks = rows(0..79).toMutableList()
        blocks[25] = AgentReasoningBlock(
            id = "reasoning", localId = null, createdAt = 25, invokedAt = 25,
            text = "Retained reasoning content", meta = null,
        )
        mount(blocks)
        browse(26, 0)
        compose.onNodeWithText("💭 Reasoning ▸").performClick()
        compose.onNodeWithText("Retained reasoning content").assertIsDisplayed()
        browse(55, 0)
        browse(26, 0)
        compose.onNodeWithText("Retained reasoning content").assertIsDisplayed()
    }

    @Test fun hiddenOnlyPageStillAcknowledgesLayoutAndShortViewportDemandsMore() {
        mount(rows(0..0))
        assertTrue(needsOlder.get())
        compose.runOnIdle { state.value = state.value.copy(historyVersion = 1, messagesVersion = 1) }
        compose.waitUntil(10_000) { layoutVersion.get() == 1L }
        assertTrue(needsOlder.get())
    }
}
