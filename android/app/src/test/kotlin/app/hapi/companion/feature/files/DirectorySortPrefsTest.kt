package app.hapi.companion.feature.files

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
 * Sort pref round-trips against a real temp-file Preferences DataStore (pure
 * JVM), including the cold-start reload path and corrupt-value degradation —
 * the web `hapi-directory-sort` localStorage twin.
 */
class DirectorySortPrefsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File = File(tmp.root, "$name.preferences_pb")

    @Test
    fun `sort round-trips and survives a cold start`() = runTest {
        val file = storeFile("sort")

        val firstScope = newScope()
        try {
            val prefs = DirectorySortPrefs(PreferenceDataStoreFactory.create(scope = firstScope) { file })
            assertEquals(DirectorySort.DEFAULT, prefs.sort.first())

            prefs.setSort(DirectorySort(DirectorySortField.MODIFIED, DirectorySortDirection.DESC))
            assertEquals(DirectorySort(DirectorySortField.MODIFIED, DirectorySortDirection.DESC), prefs.sort.first())
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        // "Second process": a fresh DataStore over the same file.
        val secondScope = newScope()
        try {
            val prefs = DirectorySortPrefs(PreferenceDataStoreFactory.create(scope = secondScope) { file })
            assertEquals(DirectorySort(DirectorySortField.MODIFIED, DirectorySortDirection.DESC), prefs.sort.first())
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `every field and direction round-trips`() = runTest {
        val scope = newScope()
        try {
            val prefs = DirectorySortPrefs(PreferenceDataStoreFactory.create(scope = scope) { storeFile("matrix") })
            for (field in DirectorySortField.entries) {
                for (direction in DirectorySortDirection.entries) {
                    val sort = DirectorySort(field, direction)
                    prefs.setSort(sort)
                    assertEquals(sort, prefs.sort.first())
                }
            }
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `unknown stored values degrade to the default`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("junk") }
            dataStore.edit {
                it[DirectorySortPrefs.FIELD_KEY] = "chaos"
                it[DirectorySortPrefs.DIRECTION_KEY] = "sideways"
            }
            assertEquals(DirectorySort.DEFAULT, DirectorySortPrefs(dataStore).sort.first())
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
