package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.WorktreeMetadata
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * JVM tests for directory grouping — cases mirror the web sidebar's
 * `groupSessionsByDirectory` (`web/src/components/SessionList.tsx`) and
 * `getPathDisplayName` (`web/src/utils/path.ts`) so the two clients
 * cannot drift apart.
 */
class SessionDirectoryGroupsTest {
    private fun summary(
        id: String,
        updatedAt: Long = 0,
        active: Boolean = false,
        pending: Int = 0,
        pinned: Boolean? = null,
        globalPinned: Boolean? = null,
        machineId: String? = "m1",
        path: String? = "/repo/app",
        worktree: WorktreeMetadata? = null,
    ): SessionSummary = SessionSummary(
        id = id,
        active = active,
        pendingRequestsCount = pending,
        pinned = pinned,
        globalPinned = globalPinned,
        updatedAt = updatedAt,
        metadata = if (path == null) {
            // "Other" arises when the session carries no metadata at all
            // (path itself is required whenever metadata exists).
            null
        } else {
            SessionSummaryMetadata(
                path = path,
                machineId = machineId,
                flavor = "claude",
                worktree = worktree,
            )
        },
    )

    private fun row(summary: SessionSummary): SessionRowUi =
        SessionRowUi(summary = summary, title = summary.id, subtitle = null, meta = null, flavor = null, unread = false)

    // ----------------------------------------------------------- directory --

    @Test
    fun `directory prefers worktree base path then session path then Other`() {
        assertEquals("/wt/base", SessionDirectoryGroups.directoryOf(summary("a", worktree = WorktreeMetadata("/wt/base", "main", "wt"))))
        assertEquals("/repo/app", SessionDirectoryGroups.directoryOf(summary("b")))
        assertEquals("Other", SessionDirectoryGroups.directoryOf(summary("c", path = null)))
    }

    @Test
    fun `group key namespaces by machine so same paths never merge`() {
        val a = SessionDirectoryGroups.keyOf(summary("a", machineId = "m1", path = "/repo/app"))
        val b = SessionDirectoryGroups.keyOf(summary("b", machineId = "m2", path = "/repo/app"))
        assertEquals("m1::/repo/app", a)
        assertEquals("m2::/repo/app", b)
        // Absent machine id gets the unknown sentinel.
        assertEquals("__unknown__::/repo/app", SessionDirectoryGroups.keyOf(summary("c", machineId = null)))
    }

    // ------------------------------------------------------- display names --

    @Test
    fun `display name keeps Other and bare names, compacts deeper paths to last two segments`() {
        assertEquals("Other", SessionDirectoryGroups.pathDisplayName("Other"))
        assertEquals("app", SessionDirectoryGroups.pathDisplayName("app"))
        assertEquals("repo/app", SessionDirectoryGroups.pathDisplayName("/repo/app"))
        assertEquals("hapi/android", SessionDirectoryGroups.pathDisplayName("/Users/me/code/hapi/android"))
        // Mixed and trailing separators collapse; empty segments drop.
        assertEquals("repo/app", SessionDirectoryGroups.pathDisplayName("\\repo\\app\\"))
        assertEquals("repo/app", SessionDirectoryGroups.pathDisplayName("/repo//app"))
    }

    // ---------------------------------------------------------- group order --

    @Test
    fun `groups sort pinned first then active then latest updated`() {
        val rows = listOf(
            row(summary("cold", updatedAt = 900)),
            row(summary("hot", updatedAt = 500, active = true)),
            row(summary("oldpin", updatedAt = 100, pinned = true, path = "/repo/old")),
            row(summary("newpin", updatedAt = 800, pinned = true, path = "/repo/new")),
        )
        val groups = SessionDirectoryGroups.groupRows(rows)
        // Pinned groups first (latest-updated among them), then the plain
        // groups by latest updatedAt. hot and cold share /repo/app — the
        // active row leads inside the group.
        assertEquals(listOf("repo/new", "repo/old", "repo/app"), groups.map { it.title })
        assertEquals(listOf("newpin"), groups[0].rows.map { it.id })
        assertEquals(listOf("oldpin"), groups[1].rows.map { it.id })
        assertEquals(listOf("hot", "cold"), groups[2].rows.map { it.id })
    }

    @Test
    fun `in-group rows sort pinned then pending-active then active then recency`() {
        val rows = listOf(
            row(summary("plain-new", updatedAt = 900)),
            row(summary("plain-old", updatedAt = 100)),
            row(summary("active", updatedAt = 300, active = true)),
            row(summary("blocked", updatedAt = 200, active = true, pending = 1)),
            row(summary("pinned", updatedAt = 50, pinned = true)),
        )
        val groups = SessionDirectoryGroups.groupRows(rows)
        assertEquals(1, groups.size)
        assertEquals(listOf("pinned", "blocked", "active", "plain-new", "plain-old"), groups[0].rows.map { it.id })
    }

    @Test
    fun `encounter order keeps first-seen group order and row order while searching`() {
        val rows = listOf(
            row(summary("z-last-dir", updatedAt = 900, path = "/z/last")),
            row(summary("a-first-dir", updatedAt = 100, path = "/a/first")),
            row(summary("z-again", updatedAt = 800, path = "/z/last")),
            row(summary("a-pinned", updatedAt = 50, pinned = true, path = "/a/first")),
        )
        val groups = SessionDirectoryGroups.groupRowsInEncounterOrder(rows)
        // No pinned-first or recency resorting: groups and rows stay as met.
        assertEquals(listOf("z/last", "a/first"), groups.map { it.title })
        assertEquals(listOf("z-last-dir", "z-again"), groups[0].rows.map { it.id })
        assertEquals(listOf("a-first-dir", "a-pinned"), groups[1].rows.map { it.id })
    }
}
