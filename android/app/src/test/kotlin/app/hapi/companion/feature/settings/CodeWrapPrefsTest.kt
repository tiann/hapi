package app.hapi.companion.feature.settings

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
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
 * Code-wrap pref round-trips against a real temp-file Preferences DataStore
 * (pure JVM), including the cold-start reload path. Web parity: localStorage
 * `hapi-code-wrap` absent = wrap off (ThemePrefsTest pattern).
 */
class CodeWrapPrefsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File = File(tmp.root, "$name.preferences_pb")

    @Test
    fun `wrap defaults to off`() = runTest {
        val scope = newScope()
        try {
            val prefs = CodeWrapPrefs(PreferenceDataStoreFactory.create(scope = scope) { storeFile("fresh") })
            assertFalse(prefs.wrap.first())
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `wrap toggle round-trips and survives a cold start`() = runTest {
        val file = storeFile("wrap")

        val firstScope = newScope()
        try {
            val prefs = CodeWrapPrefs(PreferenceDataStoreFactory.create(scope = firstScope) { file })
            assertFalse(prefs.wrap.first())
            prefs.setWrap(true)
            assertTrue(prefs.wrap.first())
            prefs.setWrap(false)
            assertFalse(prefs.wrap.first())
            prefs.setWrap(true)
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        // "Second process": a fresh DataStore over the same file keeps wrap on.
        val secondScope = newScope()
        try {
            val prefs = CodeWrapPrefs(PreferenceDataStoreFactory.create(scope = secondScope) { file })
            assertEquals(true, prefs.wrap.first())
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
