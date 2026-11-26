package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.WorktreeMetadata
import kotlin.test.Test
import kotlin.test.assertEquals

class ProjectFolderPathTest {
    @Test fun windowsWorktreeAndCheckoutShareTheFoldKey() {
        val checkout = SessionSummaryMetadata(path = "C:\\work\\repo")
        val tree = checkout.copy(path = "C:\\trees\\topic", worktree = WorktreeMetadata("C:/work/repo", "topic", "topic"))
        assertEquals("C:/work/repo", projectFolderPath(checkout))
        assertEquals(projectFolderPath(checkout), projectFolderPath(tree))
        assertEquals("/work/foo\\bar", projectFolderPath(SessionSummaryMetadata(path = "/work/foo\\bar")))
    }
}
