package app.hapi.companion.feature.chat.composer

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
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
 * Provider + language persistence round-trips against a real temp-file
 * Preferences DataStore (pure JVM), defaulting to null (hub order /
 * auto-detect) and surviving a cold start — the web
 * `hapi-transcription-provider` / `hapi-voice-lang` localStorage contract.
 */
class DictationPrefsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File = File(tmp.root, "$name.preferences_pb")

    @Test
    fun `provider and language default to null round-trip and survive a cold start`() = runTest {
        val file = storeFile("dictation")

        val firstScope = newScope()
        try {
            val prefs = DataStoreDictationPrefs(PreferenceDataStoreFactory.create(scope = firstScope) { file })
            // Fresh store: no stored choice (hub preference order, auto-detect).
            assertNull(prefs.providerId.first())
            assertNull(prefs.language.first())

            prefs.setProviderId("groq")
            prefs.setLanguage("zh-CN")
            assertEquals("groq", prefs.providerId.first())
            assertEquals("zh-CN", prefs.language.first())

            // Clearing writes removal, not an explicit null value.
            prefs.setLanguage(null)
            assertNull(prefs.language.first())
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        // "Second process": a fresh DataStore over the same file keeps the
        // last written values (groq survived, the cleared language did not).
        val secondScope = newScope()
        try {
            val prefs = DataStoreDictationPrefs(PreferenceDataStoreFactory.create(scope = secondScope) { file })
            assertEquals("groq", prefs.providerId.first())
            assertNull(prefs.language.first())
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
