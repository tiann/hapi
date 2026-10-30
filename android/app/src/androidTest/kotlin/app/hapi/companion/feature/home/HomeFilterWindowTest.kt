package app.hapi.companion.feature.home

import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.feature.sessions.SessionListViewModel
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.data.store.LastSeenStore
import java.time.LocalDate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/** Real window clock: the calendar's month list does not settle under Compose's test clock. */
class HomeFilterWindowTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val automation = instrumentation.uiAutomation
    private val context = instrumentation.targetContext

    private fun await(description: String, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return
            SystemClock.sleep(20)
        }
        val tree = descendants().joinToString("\n") {
            "${it.className}: text=${it.text}, description=${it.contentDescription}, clickable=${it.isClickable}, visible=${it.isVisibleToUser}"
        }
        fail("Timed out: $description\n$tree")
    }

    private fun descendants(): List<AccessibilityNodeInfo> {
        fun visit(node: AccessibilityNodeInfo): List<AccessibilityNodeInfo> = buildList {
            add(node)
            repeat(node.childCount) { index -> node.getChild(index)?.let { addAll(visit(it)) } }
        }
        return automation.rootInActiveWindow?.let(::visit).orEmpty()
    }

    private fun nodes(text: String): List<AccessibilityNodeInfo> = descendants().filter {
        it.text?.contains(text) == true || it.contentDescription?.contains(text) == true
    }

    private fun click(text: String) {
        await("click $text") {
            val candidates = nodes(text).filter { it.isVisibleToUser }
            if (candidates.isEmpty()) {
                descendants().firstOrNull { it.isScrollable }
                    ?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
            }
            candidates.any { node ->
                var target = node
                while (!target.isClickable) target = target.parent ?: return@any false
                target.isEnabled && target.isVisibleToUser && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }
        }
    }

    private fun click(id: Int) = click(context.getString(id))
    private fun visible(text: String) = nodes(text).any { it.isVisibleToUser }

    @Test fun machineSelectionsStayInTheSheetAndDatePickerReturnsToIt() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val viewModel = SessionListViewModel(HomeSessions(), HomeMachines(), LastSeenStore(scope), scope)
        val today = LocalDate.now().toEpochDay()
        val laptop = "${context.getString(R.string.sessions_machine_fallback, "laptop")} · 2"
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        try {
            scenario.onActivity { activity ->
                activity.enableEdgeToEdge()
                activity.setContent {
                    HapiTheme(dynamicColor = false) {
                        HomeScreen(
                            viewModel = viewModel,
                            activeHubUrl = "https://hub.example",
                            pairedHubs = listOf("https://hub.example"),
                            onSwitchHub = {}, onPairAnotherHub = {}, onSignOut = {}, onOpenSession = {},
                        )
                    }
                }
            }
            await("initial sessions") { viewModel.uiState.value.rows.size == 3 }
            click(R.string.sessions_filters)
            click(laptop)
            await("machine filter") { viewModel.uiState.value.activeMachineFilter == "laptop" }
            await("sheet remains open") { visible(laptop) }

            click(R.string.sessions_filter_dates)
            click(R.string.home_cancel)
            await("cancel returns to filters") { visible(laptop) }
            assertEquals("laptop", viewModel.uiState.value.activeMachineFilter)

            scenario.onActivity { viewModel.setDateRange(today, today) }
            await("date filter") { viewModel.uiState.value.dateRange != null }
            click(R.string.sessions_filter_dates)
            click(R.string.sessions_time_filter_apply)
            await("apply returns to filters") { visible(laptop) }
            assertEquals(today, viewModel.uiState.value.dateRange?.startEpochDay)
            assertEquals(today, viewModel.uiState.value.dateRange?.endEpochDay)

            click(R.string.sessions_filter_clear_dates)
            await("date cleared") { viewModel.uiState.value.dateRange == null }
            assertEquals("laptop", viewModel.uiState.value.activeMachineFilter)
            click(R.string.sessions_filters_done)
            await("sheet closed") { visible(context.getString(R.string.sessions_search_open)) }
            assertEquals("laptop", viewModel.uiState.value.activeMachineFilter)
        } finally {
            scenario.close()
            scope.cancel()
        }
    }
}
