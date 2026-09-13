package app.hapi.companion.feature.chat

import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.Choreographer
import android.view.FrameMetrics
import android.view.MotionEvent
import android.view.Window
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.lifecycleScope
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.ui.markdown.LocalMarkdownRenderCache
import app.hapi.companion.ui.markdown.MarkdownRenderCache
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.data.store.ChatHistoryPagingState
import app.hapi.protocol.chat.AgentTextBlock
import app.hapi.protocol.chat.VisibleChatBlock
import app.hapi.protocol.chat.UserTextBlock
import app.hapi.protocol.chat.ToolGroupBlock
import app.hapi.protocol.chat.ToolGroupingOptions
import app.hapi.protocol.chat.buildVisibleChatBlocks
import app.hapi.companion.feature.chat.blocks.previewToolCall
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in diagnostics. Deliberately NO Compose test rule/virtual frame clock. */
class ChatFrameProfileTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    private fun source(index: Int, rich: Boolean): String {
        val paragraph = "Message $index. " + "Native transcript scrolling keeps the reading position stable. ".repeat(1 + index % 4)
        if (!rich) return paragraph
        return when (index % 4) {
            0 -> "## Review $index\n\n$paragraph\n\n- **Stable identity** and `cached layout`\n- A [reference](https://example.com) with *details*\n- [x] Verified"
            1 -> "### Code $index\n\n```swift\nfunc render() {\n" + (0..<14).joinToString("\n") { "    let item$it = messages[$it] // row $index" } + "\n}\n```"
            2 -> "| File | Added | Removed |\n| --- | ---: | ---: |\n" + (0..<10).joinToString("\n") { "| source-$index-$it.swift | ${it + 2} | 1 |" }
            else -> "$paragraph\n\n> A longer explanation with **emphasis**.\n\n$paragraph"
        }
    }

    private fun row(index: Int, text: String) = AgentTextBlock(
        id = "profile-$index", localId = null, createdAt = index.toLong(), invokedAt = null,
        text = text, meta = null,
    )

    private fun state(rows: List<VisibleChatBlock>) = ChatUiState(
        sessionId = "frame-profile", header = ChatHeaderUi("Frame profile", subtitle = null, active = false, thinking = false),
        flavor = null, basePath = "/workspace/hapi", blocks = rows, permissionOverrides = emptyMap(),
        hasMore = true, isLoadingOlder = false, isSyncingTail = false, isInitialLoading = false,
        loadFailed = false, warning = null, tailRevision = 0,
    )

    private fun tools(revision: Int): ToolGroupBlock = buildVisibleChatBlocks(
        (1..200).map { index ->
            previewToolCall("profile-tool-$index", "Read", input = mapOf("file_path" to "/repo/file-$index.kt")).also {
                if (index == 200) it.tool = it.tool.copy(state = "running", result = JsonPrimitive("output ".repeat(10_000) + revision))
            }
        }, ToolGroupingOptions(hasMoreMessages = false),
    ).filterIsInstance<ToolGroupBlock>().single()

    private fun heapBytes(): Long = Runtime.getRuntime().let { it.totalMemory() - it.freeMemory() }

    @Test fun profileRealFrames() {
        assumeTrue("Opt in with -e hapiScrollProfile true", InstrumentationRegistry.getArguments().getString("hapiScrollProfile") == "true")
        val output = File(instrumentation.targetContext.getExternalFilesDir(null), "scroll-profile").apply { mkdirs() }
        val records = File(output, "frames.jsonl").apply { writeText("") }
        for (scenarioName in listOf("plain", "rich", "rich-updates", "long-message", "tool-group-updates")) {
            val sources = (0..<800).map { source(it, scenarioName != "plain") }
            val updates = (0..<100).map { sources[799] + "\n\nStreaming revision $it" }
            val cache = MarkdownRenderCache().apply { prepare(sources.toSet()) }
            val longText = "Long user message with preserved whitespace.\r\n".repeat(25_000)
            val projection = TranscriptProjection()
            val initialRows = sources.mapIndexed { index, source ->
                when {
                    scenarioName == "long-message" && index % 20 == 0 -> UserTextBlock(
                        "profile-$index", null, index.toLong(), null, longText, null, null, null, null,
                    )
                    scenarioName == "tool-group-updates" && index == 340 -> tools(0)
                    else -> row(index, source)
                }
            }
            val state = mutableStateOf(state(projection.project(initialRows)))
            lateinit var list: LazyListState
            ActivityScenario.launch(ComponentActivity::class.java).use { activity ->
                activity.onActivity { host ->
                    host.setContent {
                        list = rememberLazyListState()
                        HapiTheme(darkTheme = false, dynamicColor = false) {
                            CompositionLocalProvider(LocalMarkdownRenderCache provides cache) {
                                ChatTranscript(
                                    state.value, ChatHistoryPagingState(), 0, false,
                                    onViewport = { _, _ -> }, onLayout = { _, _ -> },
                                    onRetryHistory = {}, onJumpToLatest = {}, listState = list,
                                )
                            }
                        }
                    }
                }
                SystemClock.sleep(2_000)
                for (repetition in 1..3) {
                    // Real touch first gives history intent, then place each
                    // repetition at the same row. Setup excluded from samples.
                    swipe(activity, duration = 300)
                    activity.onActivity { it.lifecycleScope.launch { list.scrollToItem(350, 0) } }
                    SystemClock.sleep(1_000)
                    val probe = FrameProbe()
                    var startIndex = 0
                    var width = 0
                    var height = 0
                    var refreshRate = 60f
                    val heapBefore = heapBytes()
                    shell("dumpsys gfxinfo ${instrumentation.targetContext.packageName} reset")
                    activity.onActivity { host ->
                        startIndex = list.firstVisibleItemIndex
                        width = host.window.decorView.width
                        height = host.window.decorView.height
                        @Suppress("DEPRECATION")
                        refreshRate = host.windowManager.defaultDisplay.refreshRate
                        probe.start(host.window)
                        if (scenarioName == "rich-updates" || scenarioName == "tool-group-updates") host.lifecycleScope.launch {
                            var revision = 0
                            while (isActive && probe.active.get()) {
                                val next = withContext(Dispatchers.Default) {
                                    if (scenarioName == "tool-group-updates") projection.project(initialRows.mapIndexed { index, block ->
                                        if (index == 340) tools(revision) else block
                                    }) else state.value.blocks.dropLast(1) + row(799, updates[revision % updates.size])
                                }
                                state.value = state.value.copy(
                                    blocks = next,
                                    messagesVersion = state.value.messagesVersion + 1,
                                )
                                revision++
                                delay(100)
                            }
                        }
                    }
                    android.os.Trace.beginSection("HapiScroll:$scenarioName:$repetition")
                    repeat(8) {
                        swipe(activity, duration = 450)
                        SystemClock.sleep(250) // includes natural fling/deceleration
                    }
                    SystemClock.sleep(800)
                    android.os.Trace.endSection()
                    var endIndex = 0
                    activity.onActivity { host -> endIndex = list.firstVisibleItemIndex; probe.stop(host.window) }
                    probe.finish()
                    File(output, "$scenarioName-$repetition-gfxinfo.txt").writeText(shell("dumpsys gfxinfo ${instrumentation.targetContext.packageName} framestats"))
                    File(output, "$scenarioName-$repetition-memory.txt").writeText(shell("dumpsys meminfo ${instrumentation.targetContext.packageName}"))
                    val record = probe.result(refreshRate.toDouble()).apply {
                        put("scenario", scenarioName); put("repetition", repetition); put("rows", 800)
                        put("viewportWidthPx", width); put("viewportHeightPx", height)
                        put("startIndex", startIndex); put("endIndex", endIndex)
                        put("api", android.os.Build.VERSION.SDK_INT)
                        put("heapBeforeBytes", heapBefore); put("heapAfterBytes", heapBytes())
                        put("nativeHeapAllocatedBytes", android.os.Debug.getNativeHeapAllocatedSize())
                        put("longMessageUtf16Units", if (scenarioName == "long-message") longText.length else 0)
                        put("inspectedGroupTools", if (scenarioName == "tool-group-updates") 200 else 0)
                        put("metric", "window-frame-metrics-and-choreographer-not-presented-fps")
                    }
                    records.appendText(record.toString() + "\n")
                    val summary = JSONObject(record.toString()).apply { remove("framesMs"); remove("intervalsMs") }
                    android.util.Log.i("HapiFrameProfile", summary.toString())
                    assertTrue("Probe must scroll across rows", startIndex - endIndex > 5)
                    assertTrue("Must capture real rendered frames", record.getInt("renderedFrames") > 60)
                }
            }
        }
    }

    private fun shell(command: String): String = instrumentation.uiAutomation.executeShellCommand(command).use {
        android.os.ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().readText()
    }

    private fun swipe(activity: ActivityScenario<ComponentActivity>, duration: Long) {
        var width = 0
        var height = 0
        activity.onActivity { width = it.window.decorView.width; height = it.window.decorView.height }
        val down = SystemClock.uptimeMillis()
        fun send(action: Int, fraction: Float) {
            val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, width * 0.5f, height * (0.22f + fraction * 0.56f), 0)
            event.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
            try { instrumentation.sendPointerSync(event) } finally { event.recycle() }
        }
        android.os.Trace.beginSection("HapiGesture")
        try {
            send(MotionEvent.ACTION_DOWN, 0f)
            for (step in 1..30) {
                val wait = down + duration * step / 30 - SystemClock.uptimeMillis()
                if (wait > 0) SystemClock.sleep(wait)
                send(MotionEvent.ACTION_MOVE, step / 30f)
            }
            send(MotionEvent.ACTION_UP, 1f)
        } finally {
            android.os.Trace.endSection()
        }
    }

    private class FrameProbe : Choreographer.FrameCallback {
        val active = AtomicBoolean(false)
        private val thread = HandlerThread("HapiFrameMetrics").apply { start() }
        private val frames = mutableListOf<DoubleArray>()
        private val intervals = mutableListOf<Double>()
        private var droppedReports = 0
        private var previous = 0L
        private var began = 0L
        private var ended = 0L
        private val listener = Window.OnFrameMetricsAvailableListener { _, metrics, dropped ->
            if (active.get() && metrics.getMetric(FrameMetrics.FIRST_DRAW_FRAME) == 0L) {
                droppedReports += dropped
                frames += doubleArrayOf(
                    metrics.getMetric(FrameMetrics.TOTAL_DURATION) / 1e6,
                    metrics.getMetric(FrameMetrics.LAYOUT_MEASURE_DURATION) / 1e6,
                    metrics.getMetric(FrameMetrics.DRAW_DURATION) / 1e6,
                    metrics.getMetric(FrameMetrics.SYNC_DURATION) / 1e6,
                    metrics.getMetric(FrameMetrics.COMMAND_ISSUE_DURATION) / 1e6,
                )
            }
        }

        fun start(window: Window) {
            window.addOnFrameMetricsAvailableListener(listener, Handler(thread.looper))
            began = System.nanoTime()
            active.set(true)
            Choreographer.getInstance().postFrameCallback(this)
        }

        override fun doFrame(frameTimeNanos: Long) {
            if (!active.get()) return
            val now = System.nanoTime()
            if (previous != 0L) intervals += (now - previous) / 1e6
            previous = now
            Choreographer.getInstance().postFrameCallback(this)
        }

        fun stop(window: Window) {
            ended = System.nanoTime()
            active.set(false)
            Choreographer.getInstance().removeFrameCallback(this)
            window.removeOnFrameMetricsAvailableListener(listener)
            thread.quitSafely()
        }

        fun finish() { thread.join() }

        fun result(refreshRate: Double): JSONObject {
            fun percentile(values: List<Double>, quantile: Double): Double =
                values.sorted().let { if (it.isEmpty()) 0.0 else it[((it.size - 1) * quantile).toInt()] }
            val total = frames.map { it[0] }
            val seconds = (ended - began) / 1e9
            return JSONObject().apply {
                put("refreshRateHz", refreshRate); put("seconds", seconds)
                put("renderedFrames", frames.size); put("droppedMetricReports", droppedReports)
                put("callbackFPS", intervals.size / seconds)
                put("intervalP95Ms", percentile(intervals, 0.95))
                put("intervalP99Ms", percentile(intervals, 0.99))
                put("frameP50Ms", percentile(total, 0.5)); put("frameP95Ms", percentile(total, 0.95))
                put("frameP99Ms", percentile(total, 0.99)); put("maxFrameMs", total.maxOrNull())
                put("framesOverBudget", total.count { it > 1000 / refreshRate })
                put("framesOver50Ms", total.count { it > 50 })
                put("layoutP95Ms", percentile(frames.map { it[1] }, 0.95))
                put("drawP95Ms", percentile(frames.map { it[2] }, 0.95))
                put("syncP95Ms", percentile(frames.map { it[3] }, 0.95))
                put("commandP95Ms", percentile(frames.map { it[4] }, 0.95))
                put("framesMs", JSONArray(frames.map { JSONArray(it.toList()) }))
                put("intervalsMs", JSONArray(intervals))
            }
        }
    }
}
