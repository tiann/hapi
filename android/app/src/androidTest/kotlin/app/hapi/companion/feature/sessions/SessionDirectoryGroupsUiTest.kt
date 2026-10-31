package app.hapi.companion.feature.sessions

import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.After
import org.junit.Rule
import org.junit.Test

/**
 * Two machines, one directory: `/repo/app` checked out on laptop and desktop
 * alike, so both directory groups share the display title `repo/app`. Before
 * the stable-key fix the two LazyColumn headers collided on that title — this
 * case pins the regressed layout end to end (grouped default, grouped search,
 * flat search). Device verification of the rendering itself belongs to this
 * test run; compile coverage is the CI gate.
 */

/** Same `/repo/app` path on two machines — one display title, two group keys. */
private fun sharedDirectorySession(id: String, name: String, machineId: String, orderAt: Long): SessionSummary =
    SessionSummary(
        id = id,
        active = false,
        updatedAt = orderAt,
        createdAt = orderAt,
        lastUserMessageAt = orderAt,
        hasConversationContent = true,
        metadata = SessionSummaryMetadata(name = name, path = "/repo/app", machineId = machineId, flavor = "claude"),
    )

internal class DirectoryGroupSessions(now: Long) : SessionListStore {
    override val sessions = MutableStateFlow(
        listOf(
            sharedDirectorySession("laptop-row", "Laptop build", "laptop", now - 60_000L),
            sharedDirectorySession("desktop-row", "Desktop build", "desktop", now - 120_000L),
        ),
    )

    override suspend fun refresh() {}
    override fun scheduleRefresh() {}
    override suspend fun fullResync() {}
    override fun applySessionEvent(scope: SseSubscriptionKey, event: SyncEvent) {}
    override suspend fun setPinMode(sessionId: String, mode: String): Unit = error("unexpected action")
    override suspend fun archiveSession(sessionId: String): Unit = error("unexpected action")
    override suspend fun renameSession(sessionId: String, name: String): Unit = error("unexpected action")
    override suspend fun deleteSession(sessionId: String): Unit = error("unexpected action")
    override suspend fun reopenSession(sessionId: String): ReopenSessionResponse = error("unexpected action")
    override suspend fun updateSessionSummary(sessionId: String, text: String): Unit = error("unexpected action")
    override suspend fun suggestSessionTitle(sessionId: String): String = error("unexpected action")
    override suspend fun titleSuggestionAvailable(): Boolean = false
}

internal class DirectoryGroupMachines : MachineListStore {
    override val machines = MutableStateFlow<List<Machine>>(emptyList())
    override suspend fun refresh() {}
    override fun scheduleRefresh() {}
    override fun applyMachineEvent(event: SyncEvent.MachineUpdated) {}
}

class SessionDirectoryGroupsUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val sessions = DirectoryGroupSessions(System.currentTimeMillis())
    private val viewModel = SessionListViewModel(
        sessionStore = sessions,
        machineStore = DirectoryGroupMachines(),
        lastSeenStore = LastSeenStore(scope),
        scope = scope,
    )

    @After fun cleanup() { scope.cancel() }

    @Composable
    private fun Content() {
        HapiTheme(dynamicColor = false) {
            SessionListScreen(viewModel = viewModel, onOpenSession = {})
        }
    }

    @Test fun sharedTitleGroupsRenderBothHeadersAndSurviveGroupedAndFlatSearch() {
        compose.setContent { Content() }
        compose.waitUntil(10_000) { viewModel.uiState.value.rows.size == 2 }

        // Grouped default: two directory groups, one display title — the
        // machine+directory header keys keep the LazyColumn from colliding,
        // so both headers and both machines' rows render.
        compose.onAllNodesWithText("repo/app").assertCountEquals(2)
        compose.onNodeWithText("Laptop build").assertIsDisplayed()
        compose.onNodeWithText("Desktop build").assertIsDisplayed()

        // Grouped + search: both groups still keyed apart (relevance order).
        compose.runOnIdle { viewModel.setSearchQuery("build") }
        compose.waitUntil(10_000) { viewModel.uiState.value.isSearching && viewModel.uiState.value.rows.size == 2 }
        compose.onAllNodesWithText("repo/app").assertCountEquals(2)
        compose.onNodeWithText("Laptop build").assertIsDisplayed()
        compose.onNodeWithText("Desktop build").assertIsDisplayed()

        // Flat + search: the headers disappear, both rows stay reachable.
        compose.runOnIdle { viewModel.setGrouped(false) }
        compose.waitUntil(10_000) { !viewModel.uiState.value.grouped && viewModel.uiState.value.rows.size == 2 }
        compose.onAllNodesWithText("repo/app").assertCountEquals(0)
        compose.onNodeWithText("Laptop build").assertIsDisplayed()
        compose.onNodeWithText("Desktop build").assertIsDisplayed()
    }
}
