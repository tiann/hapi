package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.SummaryText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * JVM tests for the sidebar visibility rules — semantics pinned to
 * `prepareSidebarSessions` / `getSessionDedupKey` / `isSidebarEmptySessionStub`
 * in `web/src/components/SessionList.tsx`.
 */
class SessionListFiltersTest {
    private fun summary(
        id: String,
        updatedAt: Long = 0,
        active: Boolean = false,
        name: String? = null,
        summaryText: String? = null,
        flavor: String? = "claude",
        agentSessionId: String? = null,
        pinned: Boolean? = null,
        globalPinned: Boolean? = null,
        hasConversationContent: Boolean = true,
    ): SessionSummary = SessionSummary(
        id = id,
        active = active,
        updatedAt = updatedAt,
        hasConversationContent = hasConversationContent,
        pinned = pinned,
        globalPinned = globalPinned,
        metadata = SessionSummaryMetadata(
            name = name,
            path = "/repo/app",
            summary = summaryText?.let { SummaryText(it) },
            flavor = flavor,
            agentSessionId = agentSessionId,
        ),
    )

    // ------------------------------------------------------------ dedup key --

    @Test
    fun `dedup key scopes by flavor and trims the agent id`() {
        assertEquals("claude:agent-1", SessionListFilters.getSessionDedupKey(summary("s", agentSessionId = "agent-1")))
        assertEquals("codex:agent-1", SessionListFilters.getSessionDedupKey(summary("s", flavor = "codex", agentSessionId = "agent-1")))
        assertEquals("unknown:agent-1", SessionListFilters.getSessionDedupKey(summary("s", flavor = null, agentSessionId = "agent-1")))
        // Blank agent id — even after trim — is not a dedup identity.
        assertNull(SessionListFilters.getSessionDedupKey(summary("s", agentSessionId = "   ")))
        assertNull(SessionListFilters.getSessionDedupKey(summary("s", agentSessionId = null)))
    }

    @Test
    fun `dedup keeps the newest view and passes keyless sessions through`() {
        val stale = summary("stale", updatedAt = 500, agentSessionId = "agent-1", name = "Old")
        val fresh = summary("fresh", updatedAt = 900, agentSessionId = "agent-1", name = "New")
        val keyless = summary("keyless", updatedAt = 700, name = "Keyless")
        val result = SessionListFilters.deduplicateSessionsByAgentId(listOf(stale, fresh, keyless))
        assertEquals(listOf("keyless", "fresh"), result.map { it.id })
    }

    @Test
    fun `dedup winner prefers active over recency and selection over pins`() {
        // Active beats newer.
        val oldActive = summary("old-active", updatedAt = 100, active = true, agentSessionId = "a-1")
        val newIdle = summary("new-idle", updatedAt = 900, agentSessionId = "a-1")
        assertEquals(
            "old-active",
            SessionListFilters.deduplicateSessionsByAgentId(listOf(newIdle, oldActive)).single().id,
        )

        // Selection keeps the user's open row visible.
        val selected = summary("selected", updatedAt = 100, agentSessionId = "a-1")
        val other = summary("other", updatedAt = 900, agentSessionId = "a-1")
        assertEquals(
            "selected",
            SessionListFilters.deduplicateSessionsByAgentId(listOf(other, selected), selectedSessionId = "selected").single().id,
        )

        // An explicit pin survives when recency would otherwise choose.
        val pinned = summary("pinned", updatedAt = 100, agentSessionId = "a-1", pinned = true)
        val newer = summary("newer", updatedAt = 900, agentSessionId = "a-1")
        assertEquals(
            "pinned",
            SessionListFilters.deduplicateSessionsByAgentId(listOf(newer, pinned)).single().id,
        )
    }

    @Test
    fun `same agent id under different flavors does not collapse`() {
        val claudeView = summary("claude", updatedAt = 900, flavor = "claude", agentSessionId = "shared")
        val codexView = summary("codex", updatedAt = 800, flavor = "codex", agentSessionId = "shared")
        assertEquals(
            setOf("claude", "codex"),
            SessionListFilters.deduplicateSessionsByAgentId(listOf(claudeView, codexView)).map { it.id }.toSet(),
        )
    }

    // ---------------------------------------------------------- stub rules --

    @Test
    fun `stub = inactive, conversation-less, no title signal, no agent id`() {
        assertTrue(SessionListFilters.isSidebarEmptySessionStub(summary("s", hasConversationContent = false)))
        // Conversation content beats every other signal.
        assertFalse(SessionListFilters.isSidebarEmptySessionStub(summary("s", hasConversationContent = true)))
        // Active sessions are never stubs (hub's live "new session" view).
        assertFalse(SessionListFilters.isSidebarEmptySessionStub(summary("s", active = true, hasConversationContent = false)))
        // A name or summary text is a title signal.
        assertFalse(SessionListFilters.isSidebarEmptySessionStub(summary("s", hasConversationContent = false, name = "Named")))
        assertFalse(SessionListFilters.isSidebarEmptySessionStub(summary("s", hasConversationContent = false, summaryText = "Started")))
        // An agent session id means the agent side already exists.
        assertFalse(SessionListFilters.isSidebarEmptySessionStub(summary("s", hasConversationContent = false, agentSessionId = "agent-9")))
        // No metadata at all → stub.
        assertTrue(
            SessionListFilters.isSidebarEmptySessionStub(
                SessionSummary(id = "s", active = false, hasConversationContent = false),
            ),
        )
    }

    @Test
    fun `selected active and pinned rows are never hidden`() {
        val stub = summary("stub", hasConversationContent = false)
        assertTrue(SessionListFilters.shouldShowSessionInSidebar(stub, selectedSessionId = "stub"))
        assertTrue(SessionListFilters.shouldShowSessionInSidebar(summary("a", active = true, hasConversationContent = false)))
        assertTrue(SessionListFilters.shouldShowSessionInSidebar(summary("p", pinned = true, hasConversationContent = false)))
        assertTrue(SessionListFilters.shouldShowSessionInSidebar(summary("g", globalPinned = true, hasConversationContent = false)))
        // Same stub with no protecting state stays hidden.
        assertFalse(SessionListFilters.shouldShowSessionInSidebar(stub))
    }

    @Test
    fun `prepareSidebarSessions dedups first then hides stubs`() {
        val result = SessionListFilters.prepareSidebarSessions(
            listOf(
                summary("stub", hasConversationContent = false),
                summary("stale", updatedAt = 500, agentSessionId = "a-1", name = "Old"),
                summary("fresh", updatedAt = 900, agentSessionId = "a-1", name = "New"),
                summary("plain", updatedAt = 100, name = "Plain"),
            ),
        )
        // Keyless rows keep their input order ahead of the dedup winners; the
        // caller re-applies the canonical sort afterwards.
        assertEquals(listOf("plain", "fresh"), result.map { it.id })
    }

    // ------------------------------------------------------------ unread lens --

    @Test
    fun `unread lens drops seen rows and keeps the selected session`() {
        val sessions = listOf(
            summary("seen", updatedAt = 100),
            summary("unread", updatedAt = 200),
            summary("stale", updatedAt = 50),
        )
        val lastSeen = mapOf("seen" to 100L, "unread" to 150L, "stale" to 900L)
        // Order-preserving filter: the selected row keeps its input position.
        assertEquals(
            listOf("seen", "unread"),
            SessionListFilters.filterUnreadSessionsOnly(sessions, "seen", lastSeen).map { it.id },
        )
    }

    @Test
    fun `unread lens shows a manually marked row via the parked watermark`() {
        // markUnread parks the watermark one tick behind the activity, so the
        // plain comparison in the lens is enough — no manual map consulted.
        val sessions = listOf(summary("marked", updatedAt = 300))
        assertEquals(
            listOf("marked"),
            SessionListFilters.filterUnreadSessionsOnly(sessions, null, mapOf("marked" to 299L)).map { it.id },
        )
        assertEquals(
            emptyList(),
            SessionListFilters.filterUnreadSessionsOnly(sessions, null, mapOf("marked" to 300L)).map { it.id },
        )
    }

    // ---------------------------------------------------------- active lens --

    @Test
    fun `active lens drops inactive rows and keeps the selected session`() {
        val sessions = listOf(
            summary("live", updatedAt = 900, active = true),
            summary("cold", updatedAt = 800),
            summary("open", updatedAt = 700),
        )
        // Order-preserving filter; the open (inactive) row keeps its position.
        assertEquals(
            listOf("live", "open"),
            SessionListFilters.filterActiveSessionsOnly(sessions, "open").map { it.id },
        )
        assertEquals(
            listOf("live"),
            SessionListFilters.filterActiveSessionsOnly(sessions, null).map { it.id },
        )
    }
}
