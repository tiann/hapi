package app.hapi.companion.feature.sessions

import app.hapi.data.store.LastSeenStore
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata

/**
 * Sidebar visibility rules — port of `prepareSidebarSessions` and friends from
 * `web/src/components/SessionList.tsx` (session dedup by agent id plus
 * empty-stub hiding). Pure Kotlin so JVM tests cover the semantics without
 * Compose.
 */
object SessionListFilters {

    /**
     * Dedup identity: `flavor:agentSessionId`, or null when the session has no
     * agent id. Scoped by flavor — `agentSessionId` is flattened from native
     * ids and can retain a stale cross-flavor value
     * (`codexSessionId ?? claudeSessionId ?? …`).
     */
    fun getSessionDedupKey(session: SessionSummary): String? {
        val agentId = session.metadata?.agentSessionId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val flavor = session.metadata?.flavor?.takeIf { it.isNotEmpty() } ?: "unknown"
        return "$flavor:$agentId"
    }

    /**
     * Collapse rows that are multiple views of one agent session (resume
     * chains, reopen supersessions). The winner per dedup key: active session
     * (it is the live connection) → selected one → explicit pin → recency.
     * Keyless sessions pass through untouched.
     */
    fun deduplicateSessionsByAgentId(
        sessions: List<SessionSummary>,
        selectedSessionId: String? = null,
    ): List<SessionSummary> {
        val byAgentId = LinkedHashMap<String, MutableList<SessionSummary>>()
        val passthrough = mutableListOf<SessionSummary>()
        for (session in sessions) {
            val key = getSessionDedupKey(session)
            if (key == null) {
                passthrough += session
            } else {
                byAgentId.getOrPut(key) { mutableListOf() } += session
            }
        }
        val winners = byAgentId.values.map { group -> group.sortedWith(winnerOrder(selectedSessionId)).first() }
        return passthrough + winners
    }

    private fun winnerOrder(selectedSessionId: String?): Comparator<SessionSummary> = compareBy(
        // Active session always wins — it's the live connection.
        { !it.active },
        // Among inactive duplicates, keep the selected one visible.
        { it.id != selectedSessionId },
        // Preserve an explicit pin when otherwise choosing by recency.
        { it.globalPinned != true },
        { it.pinned != true },
        { -it.updatedAt },
    )

    /**
     * An inactive, conversation-less session with no title signal and no agent
     * id — the auto-created "New session" stub the sidebar hides.
     */
    fun isSidebarEmptySessionStub(session: SessionSummary): Boolean {
        if (session.active || session.hasConversationContent) return false
        val meta = session.metadata ?: return true
        if (!meta.agentSessionId.isNullOrBlank()) return false
        if (hasSessionTitleSignal(meta)) return false
        return true
    }

    private fun hasSessionTitleSignal(meta: SessionSummaryMetadata): Boolean {
        if (!meta.name.isNullOrBlank()) return true
        if (!meta.summary?.text.isNullOrBlank()) return true
        return false
    }

    fun shouldShowSessionInSidebar(session: SessionSummary, selectedSessionId: String? = null): Boolean {
        if (session.id == selectedSessionId) return true
        if (session.active || session.pinned == true || session.globalPinned == true) return true
        return !isSidebarEmptySessionStub(session)
    }

    /** Dedup first, then hide empty stubs — the web sidebar's list body. */
    fun prepareSidebarSessions(
        sessions: List<SessionSummary>,
        selectedSessionId: String? = null,
    ): List<SessionSummary> =
        deduplicateSessionsByAgentId(sessions, selectedSessionId)
            .filter { shouldShowSessionInSidebar(it, selectedSessionId) }

    /**
     * Active-only lens (`filterActiveSessionsOnly`): hide inactive sessions;
     * the open session stays visible. Applied to the prepared list BEFORE
     * search, like the reference — the search box narrows further and never
     * resurrects a hidden row.
     */
    fun filterActiveSessionsOnly(
        sessions: List<SessionSummary>,
        selectedSessionId: String?,
    ): List<SessionSummary> = sessions.filter { session ->
        session.active || session.id == selectedSessionId
    }

    /**
     * Transient unread lens (`filterUnreadSessionsOnly`): hide sessions the
     * operator has already seen. The open session stays visible. Not "needs
     * attention" — just unread. Plain watermark comparison, exactly like the
     * reference: an explicit mark-unread parks the watermark one tick behind
     * the activity, so manually-marked rows pass this filter too.
     */
    fun filterUnreadSessionsOnly(
        sessions: List<SessionSummary>,
        selectedSessionId: String?,
        lastSeen: Map<String, Long>,
    ): List<SessionSummary> = sessions.filter { session ->
        session.id == selectedSessionId || LastSeenStore.isUnread(session, lastSeen[session.id] ?: 0)
    }
}
