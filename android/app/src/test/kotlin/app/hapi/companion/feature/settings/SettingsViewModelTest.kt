@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.settings

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import app.hapi.protocol.wire.HubHealthResponse
import app.hapi.protocol.wire.HubSettings
import app.hapi.protocol.wire.UpdateHubSettingsRequest
import java.io.File
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.rules.TemporaryFolder

/** Builds an unsigned JWT with hub-shaped claims — `JwtPeek` never verifies. */
private fun fakeJwt(ns: String? = "default", uid: Long = 1): String {
    fun b64(text: String): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(text.toByteArray(Charsets.UTF_8))
    val nsPart = ns?.let { ""","ns":"$it"""" } ?: ""
    return "${b64("""{"alg":"HS256","typ":"JWT"}""")}.${b64("""{"uid":$uid$nsPart}""")}.sig"
}

/** Owner gating (`ns === 'default'`) and the About hub probe. */
class SettingsViewModelTest {

    @get:Rule
    val tmp = TemporaryFolder()

    // ------------------------------------------------------------- gating --

    @Test
    fun `only the default namespace is the owner`() {
        assertTrue(isOwnerNamespace(fakeJwt(ns = "default")))
        assertFalse(isOwnerNamespace(fakeJwt(ns = "family")))
        assertFalse(isOwnerNamespace(fakeJwt(ns = "Default"))) // case-sensitive, like the hub
    }

    @Test
    fun `gate fails closed on missing or undecodable tokens`() {
        assertFalse(isOwnerNamespace(null))
        assertFalse(isOwnerNamespace(""))
        assertFalse(isOwnerNamespace("not-a-jwt"))
        assertFalse(isOwnerNamespace(fakeJwt(ns = null))) // claim absent
    }

    // ---------------------------------------------------------- viewmodel --

    /**
     * VM + DataStore scope on the test scheduler as FOREGROUND work —
     * `advanceUntilIdle` drives it; `backgroundScope`-hosted work would never
     * run under pure virtual time (same pattern as `NewSessionViewModelTest`).
     */
    private fun runWithViewModel(
        jwt: String?,
        health: suspend () -> HubHealthResponse,
        hubSettings: suspend () -> HubSettings = {
            HubSettings(sessionSummaryContract = false, sessionSummaryInChat = false)
        },
        putHubSettings: suspend (UpdateHubSettingsRequest) -> HubSettings = { patch ->
            // Default fake echoes the patch over an all-off base.
            HubSettings(
                sessionSummaryContract = patch.sessionSummaryContract ?: false,
                sessionSummaryInChat = patch.sessionSummaryInChat ?: false,
                autoTitlePerTurn = patch.autoTitlePerTurn,
                disablePeerTools = patch.disablePeerTools,
            )
        },
        assertions: suspend TestScope.(SettingsViewModel) -> Unit,
    ) = runTest {
        val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) {
                File(tmp.root, "settings-vm-${System.nanoTime()}.preferences_pb")
            }
            val viewModel = SettingsViewModel(
                themePrefs = ThemePrefs(dataStore),
                languagePrefs = LanguagePrefs(dataStore),
                hubUrl = "https://hub.example",
                currentJwt = { jwt },
                fetchHealth = health,
                fetchHubSettings = hubSettings,
                putHubSettings = putHubSettings,
                scope = scope,
            )
            advanceUntilIdle()
            assertions(viewModel)
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `owner flag and hub health resolve from the injected seams`() = runWithViewModel(
        jwt = fakeJwt(ns = "default"),
        health = { HubHealthResponse(status = "ok", protocolVersion = 1) },
    ) { viewModel ->
        assertTrue(viewModel.isOwner.value)
        val info = viewModel.hubInfo.value
        assertTrue(info is HubInfoState.Loaded)
        assertEquals("ok", info.health.status)
        assertEquals(1, info.health.protocolVersion)
    }

    @Test
    fun `non-owner namespace hides the dashboards and health failures surface`() = runWithViewModel(
        jwt = fakeJwt(ns = "guest"),
        health = { throw RuntimeException("connection refused") },
    ) { viewModel ->
        assertFalse(viewModel.isOwner.value)
        val info = viewModel.hubInfo.value
        assertTrue(info is HubInfoState.Failed)
        assertEquals("connection refused", info.message)
    }

    @Test
    fun `theme and language setters persist through the prefs`() = runWithViewModel(
        jwt = null,
        health = { HubHealthResponse(status = "ok", protocolVersion = 1) },
    ) { viewModel ->
        viewModel.setThemeMode(ThemeMode.OLED)
        viewModel.setDynamicColor(false)
        viewModel.setLanguage(AppLanguage.SIMPLIFIED_CHINESE)
        advanceUntilIdle()

        assertEquals(ThemeMode.OLED, viewModel.themeSettings.value.mode)
        assertFalse(viewModel.themeSettings.value.dynamicColor)
        assertEquals(AppLanguage.SIMPLIFIED_CHINESE, viewModel.language.value)
    }

    // --------------------------------------------------------- hub settings --

    @Test
    fun `owner loads hub settings once the gate resolves`() = runWithViewModel(
        jwt = fakeJwt(ns = "default"),
        health = { HubHealthResponse(status = "ok", protocolVersion = 1) },
        hubSettings = {
            HubSettings(
                sessionSummaryContract = true,
                sessionSummaryInChat = false,
                autoTitlePerTurn = true,
                disablePeerTools = true,
            )
        },
    ) { viewModel ->
        val state = viewModel.hubSettings.value
        assertTrue(state is HubSettingsState.Loaded)
        assertTrue(state.settings.sessionSummaryContract)
        assertEquals(true, state.settings.autoTitlePerTurn)
        assertEquals(true, state.settings.disablePeerTools)
        assertNull(viewModel.hubSettingsSaveError.value)
    }

    @Test
    fun `upstream hub without the fork extensions keeps them null`() = runWithViewModel(
        jwt = fakeJwt(ns = "default"),
        health = { HubHealthResponse(status = "ok", protocolVersion = 1) },
        hubSettings = { HubSettings(sessionSummaryContract = false, sessionSummaryInChat = true) },
    ) { viewModel ->
        val state = viewModel.hubSettings.value
        assertTrue(state is HubSettingsState.Loaded)
        assertTrue(state.settings.sessionSummaryInChat)
        assertNull(state.settings.autoTitlePerTurn)
        assertNull(state.settings.disablePeerTools)
    }

    @Test
    fun `non-owner never fetches hub settings`() = runWithViewModel(
        jwt = fakeJwt(ns = "guest"),
        health = { HubHealthResponse(status = "ok", protocolVersion = 1) },
        hubSettings = { error("GET /api/hub-settings must not be called for non-owners") },
    ) { viewModel ->
        assertFalse(viewModel.isOwner.value)
        // Sections render only on Loaded; null = hidden, like web with no data.
        assertNull(viewModel.hubSettings.value)
    }

    @Test
    fun `load failure surfaces as Failed and hides the sections`() = runWithViewModel(
        jwt = fakeJwt(ns = "default"),
        health = { HubHealthResponse(status = "ok", protocolVersion = 1) },
        hubSettings = { throw RuntimeException("403 forbidden") },
    ) { viewModel ->
        val state = viewModel.hubSettings.value
        assertTrue(state is HubSettingsState.Failed)
        assertEquals("403 forbidden", state.message)
    }

    @Test
    fun `update success replaces the loaded state and clears the error`() = runWithViewModel(
        jwt = fakeJwt(ns = "default"),
        health = { HubHealthResponse(status = "ok", protocolVersion = 1) },
        putHubSettings = { patch ->
            HubSettings(
                sessionSummaryContract = patch.sessionSummaryContract ?: false,
                sessionSummaryInChat = true,
                autoTitlePerTurn = null,
                disablePeerTools = null,
            )
        },
    ) { viewModel ->
        viewModel.updateHubSettings(UpdateHubSettingsRequest(sessionSummaryContract = true))
        advanceUntilIdle()

        val state = viewModel.hubSettings.value
        assertTrue(state is HubSettingsState.Loaded)
        assertTrue(state.settings.sessionSummaryContract)
        assertTrue(state.settings.sessionSummaryInChat)
        assertNull(viewModel.hubSettingsSaveError.value)
    }

    @Test
    fun `update failure keeps the loaded values and surfaces the message`() = runWithViewModel(
        jwt = fakeJwt(ns = "default"),
        health = { HubHealthResponse(status = "ok", protocolVersion = 1) },
        putHubSettings = { throw RuntimeException("network down") },
    ) { viewModel ->
        viewModel.updateHubSettings(UpdateHubSettingsRequest(disablePeerTools = true))
        advanceUntilIdle()

        assertEquals("network down", viewModel.hubSettingsSaveError.value)
        // Last loaded state survives — the switches don't flip on a failed save.
        val state = viewModel.hubSettings.value
        assertTrue(state is HubSettingsState.Loaded)
        assertFalse(state.settings.sessionSummaryContract)
    }

    @Test
    fun `a second toggle while a save is in flight is dropped`() {
        var puts = 0
        runTest {
            val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
            try {
                val dataStore = PreferenceDataStoreFactory.create(scope = scope) {
                    File(tmp.root, "inflight-${System.nanoTime()}.preferences_pb")
                }
                val viewModel = SettingsViewModel(
                    themePrefs = ThemePrefs(dataStore),
                    languagePrefs = LanguagePrefs(dataStore),
                    hubUrl = "https://hub.example",
                    currentJwt = { fakeJwt(ns = "default") },
                    fetchHealth = { HubHealthResponse(status = "ok", protocolVersion = 1) },
                    fetchHubSettings = { HubSettings(false, false) },
                    putHubSettings = { patch ->
                        puts++
                        HubSettings(
                            sessionSummaryContract = patch.sessionSummaryContract ?: false,
                            sessionSummaryInChat = false,
                        )
                    },
                    scope = scope,
                )
                advanceUntilIdle()

                // Both queued before the first PUT runs → the second is a no-op
                // (web twin: `if (isPending) return`).
                viewModel.updateHubSettings(UpdateHubSettingsRequest(sessionSummaryContract = true))
                viewModel.updateHubSettings(UpdateHubSettingsRequest(sessionSummaryInChat = true))
                advanceUntilIdle()

                assertEquals(1, puts)
                assertTrue(
                    (viewModel.hubSettings.value as HubSettingsState.Loaded)
                        .settings.sessionSummaryContract,
                )
                assertFalse(
                    (viewModel.hubSettings.value as HubSettingsState.Loaded)
                        .settings.sessionSummaryInChat,
                )
            } finally {
                scope.coroutineContext[Job]?.cancelAndJoin()
            }
        }
    }
}
