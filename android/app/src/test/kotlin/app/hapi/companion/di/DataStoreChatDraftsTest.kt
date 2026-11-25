package app.hapi.companion.di

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.rules.TemporaryFolder

class DataStoreChatDraftsTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun `share append and receipt persist together across holder recreation and later edits`() = runTest {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        try {
            val store = PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "drafts.preferences_pb") }
            val first = DataStoreChatDrafts(store, "https://a.example")
            assertEquals("original\nshared", first.appendSharedText("session", "request", "original", "shared"))
            val restored = DataStoreChatDrafts(store, "https://a.example")
            assertEquals("original\nshared", restored.load("session"))
            restored.save("session", "edited")
            assertEquals("edited", restored.appendSharedText("session", "request", "edited", "shared"))
            assertEquals("edited", restored.load("session"))
            val anotherHub = DataStoreChatDrafts(store, "https://b.example")
            assertEquals("shared", anotherHub.appendSharedText("session", "request", "", "shared"))
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test fun `superseding session migration carries receipts with its draft without replacing a target draft`() = runTest {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        try {
            val store = PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "drafts.preferences_pb") }
            val drafts = DataStoreChatDrafts(store, "https://a.example")
            drafts.appendSharedText("old", "request", "draft", "shared")
            drafts.move("old", "new")
            assertEquals("draft\nshared", drafts.load("new"))
            assertEquals("draft\nshared", drafts.appendSharedText("new", "request", "draft\nshared", "shared"))
            drafts.save("existing", "keep me")
            drafts.move("new", "existing")
            assertEquals("keep me", drafts.load("existing"))
            assertEquals("keep me\nshared", drafts.appendSharedText("existing", "request", "keep me", "shared"))
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
