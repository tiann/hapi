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
        lastUserMessageAt: Long? = null,
        createdAt: Long? = null,
    ): SessionSummary = SessionSummary(
        id = id,
        active = active,
        pendingRequestsCount = pending,
        pinned = pinned,
        globalPinned = globalPinned,
        updatedAt = updatedAt,
        lastUserMessageAt = lastUserMessageAt,
        createdAt = createdAt,
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

    @Test
    fun `identical paths on different machines stay two groups sharing one display title`() {
        val rows = listOf(
            row(summary("laptop-row", updatedAt = 900, machineId = "laptop", path = "/repo/app")),
            row(summary("desktop-row", updatedAt = 800, machineId = "desktop", path = "/repo/app")),
        )
        val groups = SessionDirectoryGroups.groupRows(rows)
        // One display title, two stable machine+directory keys — LazyColumn
        // header keys derive from the group key, so nothing collides.
        assertEquals(listOf("repo/app", "repo/app"), groups.map { it.title })
        assertEquals(setOf("laptop::/repo/app", "desktop::/repo/app"), groups.map { it.key }.toSet())
        assertEquals(listOf("laptop-row"), groups.first { it.key == "laptop::/repo/app" }.rows.map { it.id })
        assertEquals(listOf("desktop-row"), groups.first { it.key == "desktop::/repo/app" }.rows.map { it.id })
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
    fun `groups sort pinned first then latest user activity`() {
        val rows = listOf(
            row(summary("cold", lastUserMessageAt = 900)),
            row(summary("hot", lastUserMessageAt = 500, active = true, updatedAt = 99_000)),
            row(summary("oldpin", lastUserMessageAt = 100, pinned = true, path = "/repo/old")),
            row(summary("newpin", lastUserMessageAt = 800, pinned = true, path = "/repo/new")),
        )
        val groups = SessionDirectoryGroups.groupRows(rows)
        // Pinned groups first (latest user activity among them), then the
        // plain groups by latest user activity. hot and cold share /repo/app,
        // but the active row's liveness and updatedAt noise never lift its
        // group or lead it inside the group.
        assertEquals(listOf("repo/new", "repo/old", "repo/app"), groups.map { it.title })
        assertEquals(listOf("newpin"), groups[0].rows.map { it.id })
        assertEquals(listOf("oldpin"), groups[1].rows.map { it.id })
        assertEquals(listOf("cold", "hot"), groups[2].rows.map { it.id })
    }

    @Test
    fun `in-group rows sort pinned first then user-activity recency`() {
        val rows = listOf(
            row(summary("plain-new", lastUserMessageAt = 900)),
            row(summary("plain-old", lastUserMessageAt = 100, active = true, pending = 3, updatedAt = 99_000)),
            row(summary("pinned", lastUserMessageAt = 50, pinned = true)),
        )
        val groups = SessionDirectoryGroups.groupRows(rows)
        assertEquals(1, groups.size)
        // The pin leads despite the oldest activity; among plain rows user
        // recency wins over liveness/output noise (active, pending,
        // updatedAt) — no active-priority tier.
        assertEquals(listOf("pinned", "plain-new", "plain-old"), groups[0].rows.map { it.id })
    }

    @Test
    fun `output and liveness changes never reorder groups`() {
        fun corpus() = listOf(
            row(summary("a", lastUserMessageAt = 1_000, path = "/a")),
            row(summary("b", lastUserMessageAt = 2_000, path = "/b")),
            row(summary("c", lastUserMessageAt = 3_000, path = "/b")),
        )
        fun ids(rows: List<SessionRowUi>) =
            SessionDirectoryGroups.groupRows(rows).flatMap { group -> group.rows.map { it.id } }

        assertEquals(listOf("c", "b", "a"), ids(corpus()))
        // Agent output / completion / permission noise must not move anything.
        val noisy = corpus()
            .map { row -> row.copy(summary = row.summary.copy(updatedAt = 99_000, active = true, thinking = true, pendingRequestsCount = 4)) }
            .reversed()
        assertEquals(listOf("c", "b", "a"), ids(noisy))
        // A fresh user message is the only signal that reorders.
        val bumped = corpus().map { row ->
            if (row.id == "a") row.copy(summary = row.summary.copy(lastUserMessageAt = 100_000)) else row
        }
        assertEquals(listOf("a", "c", "b"), ids(bumped))
    }

    @Test
    fun `creation time orders before any user input with deterministic refetch ties`() {
        val rows = listOf(
            row(summary("b", createdAt = 2_000, path = "/b")),
            row(summary("a", createdAt = 2_000, path = "/a")),
        )
        val ids = SessionDirectoryGroups.groupRows(rows).flatMap { group -> group.rows.map { it.id } }
        assertEquals(listOf("a", "b"), ids)
        assertEquals(ids, SessionDirectoryGroups.groupRows(rows.reversed()).flatMap { group -> group.rows.map { it.id } })
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
