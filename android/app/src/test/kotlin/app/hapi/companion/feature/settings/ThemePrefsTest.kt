package app.hapi.companion.feature.settings

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
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
 * Theme/language pref round-trips against a real temp-file Preferences
 * DataStore (pure JVM), including the cold-start reload path and unknown-value
 * degradation.
 */
class ThemePrefsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File = File(tmp.root, "$name.preferences_pb")

    @Test
    fun `theme settings round-trip and survive a cold start`() = runTest {
        val file = storeFile("theme")

        val firstScope = newScope()
        try {
            val prefs = ThemePrefs(PreferenceDataStoreFactory.create(scope = firstScope) { file })
            assertEquals(ThemeSettings(ThemeMode.SYSTEM, dynamicColor = true), prefs.settings.first())

            prefs.setMode(ThemeMode.OLED)
            prefs.setDynamicColor(false)
            assertEquals(ThemeSettings(ThemeMode.OLED, dynamicColor = false), prefs.settings.first())
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        // "Second process": a fresh DataStore over the same file.
        val secondScope = newScope()
        try {
            val prefs = ThemePrefs(PreferenceDataStoreFactory.create(scope = secondScope) { file })
            assertEquals(ThemeSettings(ThemeMode.OLED, dynamicColor = false), prefs.settings.first())
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `every theme mode round-trips through its storage key`() = runTest {
        val scope = newScope()
        try {
            val prefs = ThemePrefs(PreferenceDataStoreFactory.create(scope = scope) { storeFile("modes") })
            for (mode in ThemeMode.entries) {
                prefs.setMode(mode)
                assertEquals(mode, prefs.settings.first().mode)
            }
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `unknown stored values degrade to defaults`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("junk") }
            dataStore.edit {
                it[ThemePrefs.MODE_KEY] = "amoled-ultra"
                it[LanguagePrefs.LANGUAGE_KEY] = "klingon"
            }
            assertEquals(ThemeMode.SYSTEM, ThemePrefs(dataStore).settings.first().mode)
            // Unknown language keys degrade to follow-system (B-M5a default).
            assertEquals(AppLanguage.SYSTEM, LanguagePrefs(dataStore).language.first())
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `language choice round-trips and coexists with theme keys`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("lang") }
            val language = LanguagePrefs(dataStore)
            val theme = ThemePrefs(dataStore)

            // Nothing stored yet: follow-system is the B-M5a default.
            assertEquals(AppLanguage.SYSTEM, language.language.first())
            language.setLanguage(AppLanguage.SIMPLIFIED_CHINESE)
            theme.setMode(ThemeMode.DARK)

            assertEquals(AppLanguage.SIMPLIFIED_CHINESE, language.language.first())
            assertEquals(ThemeMode.DARK, theme.settings.first().mode)
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
