@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.settings

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import app.hapi.protocol.wire.HubHealthResponse
import java.io.File
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
}
