package app.hapi.companion.feature.home

import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.Build
import android.view.KeyEvent
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.ime
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.feature.sessions.SessionListViewModel
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.data.sse.SseSubscriptionKey
import app.hapi.data.store.LastSeenStore
import app.hapi.data.store.MachineListStore
import app.hapi.data.store.SessionListStore
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.ReopenSessionResponse
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.SyncEvent
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.After
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

internal class HomeSessions : SessionListStore {
    private val updatedAt = LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
    override val sessions = MutableStateFlow(listOf(
        SessionSummary("build", true, updatedAt = updatedAt, hasConversationContent = true,
            metadata = SessionSummaryMetadata(name = "Build API", path = "/repo/api", machineId = "laptop")),
        SessionSummary("fix", true, updatedAt = updatedAt, hasConversationContent = true,
            metadata = SessionSummaryMetadata(name = "Fix Android", path = "/repo/android", machineId = "laptop")),
        SessionSummary("research", true, updatedAt = updatedAt, hasConversationContent = true,
            metadata = SessionSummaryMetadata(name = "Research", path = "/repo/research", machineId = "desktop")),
    ))
    override suspend fun refresh() {}
    override fun scheduleRefresh() {}
    override suspend fun fullResync() {}
    override fun applySessionEvent(scope: SseSubscriptionKey, event: SyncEvent) {}
    override suspend fun setPinMode(sessionId: String, mode: String): Unit = error("unexpected action")
    override suspend fun archiveSession(sessionId: String): Unit = error("unexpected action")
    override suspend fun renameSession(sessionId: String, name: String): Unit = error("unexpected action")
    override suspend fun deleteSession(sessionId: String): Unit = error("unexpected action")
    override suspend fun reopenSession(sessionId: String): ReopenSessionResponse = error("unexpected action")
}

internal class HomeMachines : MachineListStore {
    override val machines = MutableStateFlow<List<Machine>>(emptyList())
    override suspend fun refresh() {}
    override fun scheduleRefresh() {}
    override fun applyMachineEvent(event: SyncEvent.MachineUpdated) {}
}

class HomeScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val sessions = HomeSessions()
    private val viewModel = SessionListViewModel(sessions, HomeMachines(), LastSeenStore(scope), scope)
    private val today = LocalDate.now().toEpochDay()
    @Volatile private var imeVisible = false
    /** Compose's reported IME inset height, captured next to [imeVisible] for diagnostics. */
    @Volatile private var composeImeBottom = -1

    @Before fun configureWindow() {
        compose.runOnUiThread {
            compose.activity.enableEdgeToEdge()
            @Suppress("DEPRECATION")
            compose.activity.window.setSoftInputMode(
                if (Build.VERSION.SDK_INT >= 30) WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
                else WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE,
            )
        }
    }

    @After fun cleanup() { scope.cancel() }

    @OptIn(ExperimentalLayoutApi::class)
    @Composable
    private fun Content() {
        val showingKeyboard = WindowInsets.isImeVisible
        val imeBottom = WindowInsets.ime.getBottom(LocalDensity.current)
        SideEffect {
            imeVisible = showingKeyboard
            composeImeBottom = imeBottom
        }
        HapiTheme(dynamicColor = false) {
            HomeScreen(
                viewModel = viewModel,
                activeHubUrl = "https://hub.example",
                pairedHubs = listOf("https://hub.example"),
                onSwitchHub = {}, onPairAnotherHub = {}, onSignOut = {}, onOpenSession = {},
            )
        }
    }

    private fun mount(expectedRows: Int = 3) {
        compose.setContent { Content() }
        compose.waitUntil(10_000) { viewModel.uiState.value.rows.size == expectedRows }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithContentDescription(label(R.string.sessions_filters))
                .fetchSemanticsNodes(atLeastOneRootRequired = false).isNotEmpty()
        }
    }

    private fun label(id: Int) = context.getString(id)
    private fun openFilters() = compose.onNodeWithContentDescription(label(R.string.sessions_filters)).performClick()
    // Send a real Back event: dispatching straight to the activity skips the
    // IME's pre-IME handling, which dismisses the keyboard before app callbacks.
    private fun pressBack() {
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
    }

    private fun platformImeVisible(): Boolean {
        var visible = false
        compose.runOnUiThread {
            // On API 29 the decor sees IME insets that ADJUST_RESIZE consumes
            // before they reach Compose. Observe the actual window instead.
            visible = ViewCompat.getRootWindowInsets(compose.activity.window.decorView)
                ?.isVisible(WindowInsetsCompat.Type.ime()) == true
        }
        return visible
    }

    /**
     * Wait for a named phase and, on timeout, report which phase stalled plus
     * the IME signals observed by both Compose and the platform (tiann/hapi#2253).
     * The behaviour under test is unchanged; only the failure message is.
     */
    private fun awaitPhase(phase: String, condition: () -> Boolean) {
        try {
            compose.waitUntil(PHASE_TIMEOUT_MS) { condition() }
        } catch (timeout: ComposeTimeoutException) {
            throw AssertionError("Timed out after ${PHASE_TIMEOUT_MS}ms: $phase (${imeState()})", timeout)
        }
    }

    private fun imeState(): String {
        val insets = ViewCompat.getRootWindowInsets(compose.activity.window.decorView)
        val keyboard = when (compose.activity.resources.configuration.keyboard) {
            Configuration.KEYBOARD_NOKEYS -> "nokeys"
            Configuration.KEYBOARD_QWERTY -> "qwerty"
            Configuration.KEYBOARD_12KEY -> "12key"
            else -> "other"
        }
        return "sdk=${Build.VERSION.SDK_INT}, " +
            "composeIsImeVisible=$imeVisible, " +
            "compatIsVisible=${insets?.isVisible(WindowInsetsCompat.Type.ime())}, " +
            "imeInsetBottom=${insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom}, " +
            "composeImeBottom=$composeImeBottom, " +
            "keyboard=$keyboard, " +
            "softInputMode=${compose.activity.window.attributes.softInputMode}"
    }

    private fun capture(name: String) {
        if (InstrumentationRegistry.getArguments().getString("screenshots") != "true") return
        compose.waitForIdle()
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        File(context.getExternalFilesDir(null), "toolbar-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @Test fun closingSearchClearsTheQueryAndKeepsMachineAndDateFilters() {
        mount()
        capture("normal")
        compose.runOnIdle {
            viewModel.setMachineFilter("laptop")
            viewModel.setDateRange(today, today)
        }
        compose.waitUntil(10_000) { viewModel.uiState.value.rows.size == 2 }
        compose.onNodeWithTag("home-search-input").assertDoesNotExist()
        compose.onNodeWithContentDescription(label(R.string.sessions_search_open)).performClick()
        compose.onNodeWithTag("home-search-input").performTextInput("Build")
        compose.waitUntil(10_000) { viewModel.uiState.value.rows.size == 1 }
        compose.onNodeWithText("Build API").assertIsDisplayed()
        compose.onNodeWithText("Fix Android").assertDoesNotExist()
        capture("search")
        compose.onNodeWithContentDescription(label(R.string.sessions_search_close)).performClick()
        compose.waitUntil(10_000) { viewModel.uiState.value.searchQuery.isEmpty() && viewModel.uiState.value.rows.size == 2 }
        compose.onNodeWithTag("home-search-input").assertDoesNotExist()
        compose.onNodeWithText("Fix Android").assertIsDisplayed()
        assertEquals("laptop", viewModel.uiState.value.activeMachineFilter)
        assertNotNull(viewModel.uiState.value.dateRange)
        compose.onNodeWithContentDescription(label(R.string.sessions_filters))
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, label(R.string.sessions_filters_active)))
    }

    @Test fun singleMachineStillOffersDateFilteringAndReset() {
        sessions.sessions.value = sessions.sessions.value.filter { it.metadata?.machineId == "laptop" }
        viewModel.setDateRange(today, today)
        mount(expectedRows = 2)
        openFilters()
        compose.onNodeWithText(label(R.string.sessions_filter_machines)).assertDoesNotExist()
        compose.onNodeWithTag("session-date-filter").assertIsDisplayed()
        compose.onNodeWithText(label(R.string.sessions_filters_reset)).performClick()
        compose.waitUntil(10_000) { !viewModel.uiState.value.hasActiveFilters }
        compose.onNodeWithText(label(R.string.sessions_filter_any_date)).assertIsDisplayed()
        compose.onNodeWithText(label(R.string.sessions_filters_reset)).assertIsNotEnabled()
        compose.onNodeWithText(label(R.string.sessions_filters_done)).performClick()
        compose.onNodeWithContentDescription(label(R.string.sessions_filters)).assertIsDisplayed()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, label(R.string.sessions_filter_all)))
        assertNull(viewModel.uiState.value.activeMachineFilter)
    }

    @Test fun searchExpansionAndQuerySurviveStateRestoration() {
        val restoration = StateRestorationTester(compose)
        restoration.setContent { Content() }
        compose.waitUntil(10_000) { viewModel.uiState.value.rows.size == 3 }
        compose.onNodeWithContentDescription(label(R.string.sessions_search_open)).performClick()
        compose.onNodeWithTag("home-search-input").performTextInput("Build")
        compose.waitUntil(10_000) { viewModel.uiState.value.searchQuery == "Build" }
        compose.onNodeWithTag("home-search-input").assertTextEquals("Build")
        restoration.emulateSavedInstanceStateRestore()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("home-search-input").fetchSemanticsNodes().singleOrNull()
                ?.config?.get(SemanticsProperties.EditableText)?.text == "Build"
        }
        assertEquals("Build", viewModel.uiState.value.searchQuery)
        compose.onNodeWithTag("home-search-input").assertIsDisplayed().assertTextEquals("Build")
        compose.onNodeWithContentDescription(label(R.string.sessions_search_close)).performClick()
        compose.waitUntil(10_000) { viewModel.uiState.value.rows.size == 3 }
        compose.onNodeWithTag("home-search-input").assertDoesNotExist()
    }

    @Test fun backDismissesKeyboardBeforeSearchAndImeSearchKeepsTheQuery() {
        mount()
        compose.onNodeWithContentDescription(label(R.string.sessions_search_open)).performClick()
        compose.onNodeWithTag("home-search-input").performTextInput("Build")
        awaitPhase("IME appears after opening search") { platformImeVisible() }
        pressBack()
        awaitPhase("IME hides after Back") { !platformImeVisible() }
        compose.onNodeWithTag("home-search-input").assertIsDisplayed().assertTextEquals("Build")

        compose.onNodeWithTag("home-search-input").performClick()
        awaitPhase("IME appears after re-focusing the search field") { platformImeVisible() }
        compose.onNodeWithTag("home-search-input").performImeAction()
        awaitPhase("IME hides after the IME Search action") { !platformImeVisible() }
        compose.onNodeWithTag("home-search-input").assertIsDisplayed().assertTextEquals("Build")
        pressBack()
        awaitPhase("search closes once the keyboard is already hidden") {
            viewModel.uiState.value.searchQuery.isEmpty()
        }
        compose.onNodeWithTag("home-search-input").assertDoesNotExist()
        compose.onNodeWithContentDescription(label(R.string.sessions_search_open)).assertIsDisplayed()
    }

    private companion object {
        const val PHASE_TIMEOUT_MS = 10_000L
    }
}
