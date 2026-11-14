package app.hapi.companion.feature.sessions

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import app.hapi.protocol.wire.SessionListOrder
import app.hapi.protocol.wire.SessionListSort
import java.io.File
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
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Sort + Active first persist app-wide; defaults are absent keys. */
class SessionListOrderPrefsTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun `choices round-trip across a cold start and defaults stay absent`() = runTest {
        val file = File(tmp.root, "order.preferences_pb")
        val firstScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = firstScope) { file }
            val prefs = SessionListOrderPrefs(dataStore)
            assertEquals(SessionListOrder.Default, prefs.order.first())
            prefs.setSort(SessionListSort.Created)
            prefs.setActiveFirst(false)
            assertEquals(SessionListOrder(SessionListSort.Created, activeFirst = false), prefs.order.first())
            prefs.setActiveFirst(true)
            assertNull(dataStore.data.first()[SessionListOrderPrefs.ACTIVE_FIRST_KEY], "Defaults are stored as absent keys")
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        val secondScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        try {
            val prefs = SessionListOrderPrefs(PreferenceDataStoreFactory.create(scope = secondScope) { file })
            assertEquals(SessionListOrder(SessionListSort.Created, activeFirst = true), prefs.order.first())
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
