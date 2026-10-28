package app.hapi.companion.feature.settings

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.rules.TemporaryFolder

/**
 * Display-preference round-trips against a real temp-file Preferences DataStore
 * (pure JVM, ThemePrefsTest pattern): web-aligned defaults, full-settings
 * persistence across a cold start, per-field degradation of corrupt values,
 * and update composition over the persisted snapshot.
 */
class DataStoreDisplayPrefsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File = File(tmp.root, "$name.preferences_pb")

    @Test
    fun `empty store reads web-aligned defaults`() = runTest {
        val scope = newScope()
        try {
            val prefs = DataStoreDisplayPrefs(
                PreferenceDataStoreFactory.create(scope = scope) { storeFile("defaults") },
            )
            assertEquals(DisplaySettings(), prefs.settings.first())
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `full settings round-trip and survive a cold start`() = runTest {
        val file = storeFile("roundtrip")
        val expected = DisplaySettings(
            sessionPreviewLimit = 42,
            showActiveSessionsOnly = true,
            pinInProgressSessions = true,
            sessionListStatusMode = SessionListStatusMode.DETAILED,
            headerMetadata = SessionHeaderMetadata(
                showLabels = false,
                agent = false,
                machine = false,
                lastActive = false,
                model = false,
                reasoning = false,
                fastMode = false,
                createdAt = true,
                updatedAt = true,
                worktree = false,
            ),
            fontScale = AppFontScale.XL,
        )

        val firstScope = newScope()
        try {
            val prefs = DataStoreDisplayPrefs(PreferenceDataStoreFactory.create(scope = firstScope) { file })
            assertEquals(DisplaySettings(), prefs.settings.first())
            prefs.update { expected }
            assertEquals(expected, prefs.settings.first())
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        // "Second process": a fresh DataStore over the same file.
        val secondScope = newScope()
        try {
            val prefs = DataStoreDisplayPrefs(PreferenceDataStoreFactory.create(scope = secondScope) { file })
            assertEquals(expected, prefs.settings.first())
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `corrupt or out-of-range stored values degrade per field`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("junk") }
            dataStore.edit {
                it[DataStoreDisplayPrefs.SESSION_PREVIEW_LIMIT_KEY] = 500
                it[DataStoreDisplayPrefs.FONT_SCALE_KEY] = 9f
                it[DataStoreDisplayPrefs.STATUS_MODE_KEY] = "ultra"
                it[DataStoreDisplayPrefs.HEADER_AGENT_KEY] = false
                it[DataStoreDisplayPrefs.HEADER_CREATED_AT_KEY] = true
            }

            val settings = DataStoreDisplayPrefs(dataStore).settings.first()

            // Out-of-range numbers snap back; junk enums degrade; stored
            // booleans are honored — degradation never resets other fields.
            assertEquals(99, settings.sessionPreviewLimit)
            assertEquals(AppFontScale.XXL, settings.fontScale)
            assertEquals(SessionListStatusMode.STANDARD, settings.sessionListStatusMode)
            assertFalse(settings.headerMetadata.agent)
            assertTrue(settings.headerMetadata.createdAt)
            assertTrue(settings.headerMetadata.worktree)
            assertFalse(settings.headerMetadata.updatedAt)
            assertFalse(settings.showActiveSessionsOnly)
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `update composes over the persisted value and the write path clamps`() = runTest {
        val scope = newScope()
        try {
            val prefs = DataStoreDisplayPrefs(
                PreferenceDataStoreFactory.create(scope = scope) { storeFile("compose") },
            )

            prefs.update { it.copy(sessionPreviewLimit = 10) }
            prefs.update { it.copy(sessionPreviewLimit = it.sessionPreviewLimit + 5) }
            assertEquals(15, prefs.settings.first().sessionPreviewLimit)

            // Writers outside the UI (or racing taps) cannot escape the range.
            prefs.update { it.copy(sessionPreviewLimit = 500) }
            assertEquals(99, prefs.settings.first().sessionPreviewLimit)
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
