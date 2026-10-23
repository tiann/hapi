package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.SessionSummary

/**
 * Directory grouping for the session list (web `groupSessionsByDirectory`,
 * `SessionList.tsx`). The web sidebar is ALWAYS grouped by working
 * directory; on Android grouping is a display toggle ([SessionDisplayPrefs])
 * — grouped is the default (web parity), flat list the alternative.
 *
 * Group key: `machineId::directory` where directory =
 * `metadata.worktree.basePath ?? metadata.path ?? "Other"` — sessions on
 * different machines never merge even when paths coincide.
 */
object SessionDirectoryGroups {

    /** One directory bucket as rendered by the list. */
    data class GroupUi(
        /** `machineId::directory` — stable across recompositions. */
        val key: String,
        /** Display name (`pathDisplayName`); the raw path stays in the title. */
        val title: String,
        val rows: List<SessionRowUi>,
    )

    /** Directory bucket for a session (web lines: worktree basePath → path → "Other"). */
    fun directoryOf(summary: SessionSummary): String =
        summary.metadata?.worktree?.basePath
            ?: summary.metadata?.path
            ?: "Other"

    /** Group key; machines are never merged (`__unknown__` when absent). */
    fun keyOf(summary: SessionSummary): String {
        val machineId = summary.metadata?.machineId
        return "${machineId ?: UNKNOWN_MACHINE_ID}::${directoryOf(summary)}"
    }

    /**
     * Compact display name (web `getPathDisplayName`, `utils/path.ts`):
     * "Other" stays as-is; a bare name stays; deeper paths show the last
     * two segments (`…/parent/leaf` → `parent/leaf`).
     */
    fun pathDisplayName(path: String): String {
        if (path == "Other") return path
        val parts = path.split(Regex("[\\\\/]+")).filter { it.isNotEmpty() }
        if (parts.isEmpty()) return path
        if (parts.size == 1) return parts[0]
        return "${parts[parts.size - 2]}/${parts[parts.lastIndex]}"
    }

    /**
     * Group rows by directory in the web's display order: groups holding a
     * pinned session first, then groups with an active session, then latest
     * `updatedAt` descending. In-group rows sort pinned first, then active
     * (pending-requests ahead of plain active), then recency — matching the
     * web comparator exactly.
     */
    fun groupRows(rows: List<SessionRowUi>): List<GroupUi> {
        // stdlib groupBy preserves encounter order; sorting happens below.
        val grouped = rows.groupBy { keyOf(it.summary) }
        return grouped.values
            .map { rowsInGroup -> rowsInGroup.sortedWith(inGroupComparator()) }
            .map { sorted -> GroupUi(keyOf(sorted.first().summary), titleOf(sorted), sorted) }
            .sortedWith(groupComparator())
    }

    /**
     * Group rows keeping first-encounter order — used while searching, where
     * the incoming rows already carry relevance order (web ranks groups by
     * search relevance instead of pinned-first).
     */
    fun groupRowsInEncounterOrder(rows: List<SessionRowUi>): List<GroupUi> =
        rows.groupBy { keyOf(it.summary) }
            .map { (key, rowsInGroup) -> GroupUi(key, titleOf(rowsInGroup), rowsInGroup) }

    private fun titleOf(rowsInGroup: List<SessionRowUi>): String =
        pathDisplayName(directoryOf(rowsInGroup.first().summary))

    /** Web in-group sort: pinned → active-with-pendingRequests → active → recency. */
    private fun inGroupComparator(): Comparator<SessionRowUi> =
        compareBy<SessionRowUi>(
            { it.summary.pinned != true },
            { activityRank(it.summary) },
        ).thenByDescending { it.summary.updatedAt }

    /** Web group sort: has-pinned → has-active → latest updatedAt desc. */
    private fun groupComparator(): Comparator<GroupUi> =
        compareBy<GroupUi>(
            { group -> group.rows.none { it.summary.pinned == true } },
            { group -> group.rows.none { it.summary.active } },
        ).thenByDescending { group -> group.rows.maxOf { it.summary.updatedAt } }

    private fun activityRank(summary: SessionSummary): Int = when {
        summary.active && summary.pendingRequestsCount > 0 -> 0
        summary.active -> 1
        else -> 2
    }
}
