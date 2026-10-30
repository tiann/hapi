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
 * Chat-preference round-trips against a real temp-file Preferences DataStore
 * (DataStoreDisplayPrefsTest pattern): documented defaults, full-settings
 * persistence across a cold start, per-field degradation of corrupt values,
 * and update composition over the persisted snapshot.
 */
class DataStoreChatPrefsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File = File(tmp.root, "$name.preferences_pb")

    @Test
    fun `empty store reads the documented defaults`() = runTest {
        val scope = newScope()
        try {
            val prefs = DataStoreChatPrefs(
                PreferenceDataStoreFactory.create(scope = scope) { storeFile("defaults") },
            )
            assertEquals(ChatSettings(), prefs.settings.first())
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `full settings round-trip and survive a cold start`() = runTest {
        val file = storeFile("roundtrip")
        val expected = ChatSettings(
            enterBehavior = ComposerEnterBehavior.SEND,
            reasoningCollapsed = false,
            toolCardsCollapsed = true,
            toolGroupBackground = ChatSurfaceColor.SOFT_BLUE,
            userMessageBackground = ChatSurfaceColor.SOFT_YELLOW,
        )

        val firstScope = newScope()
        try {
            val prefs = DataStoreChatPrefs(PreferenceDataStoreFactory.create(scope = firstScope) { file })
            assertEquals(ChatSettings(), prefs.settings.first())
            prefs.update { expected }
            assertEquals(expected, prefs.settings.first())
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        // "Second process": a fresh DataStore over the same file.
        val secondScope = newScope()
        try {
            val prefs = DataStoreChatPrefs(PreferenceDataStoreFactory.create(scope = secondScope) { file })
            assertEquals(expected, prefs.settings.first())
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `corrupt or out-of-enum stored values degrade per field`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("junk") }
            dataStore.edit {
                it[DataStoreChatPrefs.ENTER_BEHAVIOR_KEY] = "return"
                it[DataStoreChatPrefs.REASONING_COLLAPSED_KEY] = false
                it[DataStoreChatPrefs.TOOL_GROUP_BACKGROUND_KEY] = "custom:#ff8800"
                it[DataStoreChatPrefs.USER_MESSAGE_BACKGROUND_KEY] = "soft-green"
            }

            val settings = DataStoreChatPrefs(dataStore).settings.first()

            // Junk enums degrade to the defaults; stored booleans are honored —
            // degradation never resets other fields.
            assertEquals(ComposerEnterBehavior.NEWLINE, settings.enterBehavior)
            assertFalse(settings.reasoningCollapsed)
            assertFalse(settings.toolCardsCollapsed)
            assertEquals(ChatSurfaceColor.DEFAULT, settings.toolGroupBackground)
            assertEquals(ChatSurfaceColor.SOFT_GREEN, settings.userMessageBackground)
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `update composes over the persisted value`() = runTest {
        val scope = newScope()
        try {
            val prefs = DataStoreChatPrefs(
                PreferenceDataStoreFactory.create(scope = scope) { storeFile("compose") },
            )

            prefs.update { it.copy(enterBehavior = ComposerEnterBehavior.SEND) }
            prefs.update { it.copy(reasoningCollapsed = false) }
            assertEquals(ComposerEnterBehavior.SEND, prefs.settings.first().enterBehavior)
            assertFalse(prefs.settings.first().reasoningCollapsed)
            // An unrelated later write never clobbers earlier fields.
            prefs.update { it.copy(toolGroupBackground = ChatSurfaceColor.SOFT_GREEN) }
            assertFalse(prefs.settings.first().reasoningCollapsed)
            assertEquals(ChatSurfaceColor.SOFT_GREEN, prefs.settings.first().toolGroupBackground)
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
