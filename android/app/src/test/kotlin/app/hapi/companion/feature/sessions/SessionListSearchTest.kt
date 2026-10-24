package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.SummaryText
import app.hapi.protocol.wire.WorktreeMetadata
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * JVM tests for session-list search — cases mirror
 * `web/src/lib/sessionListSearch.test.ts` (and the wildcard matcher in
 * `shared/src/search.test.ts`) so the two clients cannot drift apart.
 */
class SessionListSearchTest {
    private fun summary(
        id: String,
        updatedAt: Long = 0,
        name: String? = null,
        summaryText: String? = null,
        path: String = "/repo/app",
        flavor: String? = "claude",
        machineId: String? = null,
        worktree: WorktreeMetadata? = null,
        pinned: Boolean? = null,
    ): SessionSummary = SessionSummary(
        id = id,
        active = false,
        updatedAt = updatedAt,
        pinned = pinned,
        metadata = SessionSummaryMetadata(
            name = name,
            path = path,
            machineId = machineId,
            summary = summaryText?.let { SummaryText(it) },
            flavor = flavor,
            worktree = worktree,
        ),
    )

    // ------------------------------------------------- inclusion / boundary --

    @Test
    fun `inclusion is a case-insensitive substring gate`() {
        assertTrue(SessionListSearch.searchFieldIncludesQuery("Home Assistant", "home ass"))
        assertTrue(SessionListSearch.searchFieldIncludesQuery("HAPI", "api"))
        assertFalse(SessionListSearch.searchFieldIncludesQuery("homelab", "home "))
        assertTrue(SessionListSearch.searchFieldIncludesQuery("anything", ""))
    }

    @Test
    fun `boundary match requires a non-alphanumeric edge`() {
        assertTrue(SessionListSearch.searchFieldHasBoundaryMatch("Home Assistant", "home"))
        assertTrue(SessionListSearch.searchFieldHasBoundaryMatch("my home!", "home"))
        assertFalse(SessionListSearch.searchFieldHasBoundaryMatch("homelab", "home"))
        assertFalse(SessionListSearch.searchFieldHasBoundaryMatch("myhome", "home"))
        assertTrue(SessionListSearch.searchFieldHasBoundaryMatch("anything", ""))
    }

    @Test
    fun `tokenizer splits on whitespace and drops empties`() {
        assertEquals(listOf("home", "assistant"), SessionListSearch.tokenizeSearchQuery("  Home   ASSISTANT "))
        assertEquals(emptyList(), SessionListSearch.tokenizeSearchQuery("   "))
    }

    // ------------------------------------------------------------- wildcard --

    @Test
    fun `wildcard detection and matching`() {
        assertTrue(SessionListSearch.isWildcardSearch("*coding"))
        assertTrue(SessionListSearch.isWildcardSearch("cod?ng"))
        assertFalse(SessionListSearch.isWildcardSearch("coding"))

        // Non-wildcard queries stay substring matches.
        assertTrue(SessionListSearch.matchesSearchQuery("/work/coding/hapi", "coding/hapi"))
        // Wildcards are a FULL-VALUE match (not search-anywhere): `*` spans
        // path segments, `?` eats exactly one code point.
        assertTrue(SessionListSearch.matchesSearchQuery("/work/coding/hapi", "*coding/hapi*"))
        assertTrue(SessionListSearch.matchesSearchQuery("/work/coding/hapi", "*coding?hapi"))
        // Without a leading star the pattern must match from the value's start.
        assertFalse(SessionListSearch.matchesSearchQuery("/work/coding/hapi", "coding?hapi"))
        assertFalse(SessionListSearch.matchesSearchQuery("/work/coding/hapi", "coding??hapi"))
        // Star backtracking: the greedy first match must be retried.
        assertTrue(SessionListSearch.matchesSearchQuery("a-b-c", "a*b*c"))
        assertFalse(SessionListSearch.matchesSearchQuery("a-b", "a*c"))
        // Trailing stars may dangle past the input.
        assertTrue(SessionListSearch.matchesSearchQuery("hapi", "hapi***"))
        assertFalse(SessionListSearch.matchesSearchQuery("hapi", "hapix*"))
    }

    @Test
    fun `wildcards operate on code points not utf16 units`() {
        // 😀 is one code point but two UTF-16 units; `?` must consume it whole.
        assertTrue(SessionListSearch.matchesSearchQuery("a😀b", "a?b"))
        assertFalse(SessionListSearch.matchesSearchQuery("a😀b", "a??b"))
    }

    // ------------------------------------------------------- field collection --

    @Test
    fun `collected fields cover title worktree summary flavor machine path id`() {
        val session = summary(
            "sess-1",
            name = "Named",
            summaryText = "Working on it",
            path = "/data/github/hapi",
            machineId = "m1",
            worktree = WorktreeMetadata(basePath = "/data/github/hapi", branch = "fix", name = "devbox-branch"),
        )
        val fields = SessionListSearch.collectSessionSearchFields(session, machineLabel = "MacBook")
        assertEquals(listOf("Named"), fields.title)
        assertEquals(listOf("devbox-branch"), fields.worktreeLabel)
        assertEquals(listOf("Working on it"), fields.summary)
        assertEquals(listOf("claude"), fields.flavor)
        assertEquals(listOf("MacBook"), fields.machine)
        assertEquals(listOf("/data/github/hapi", "/data/github/hapi"), fields.path)
        assertEquals(listOf("sess-1"), fields.id)
    }

    @Test
    fun `worktree label falls back to the last path segment`() {
        assertEquals(
            "hapi",
            SessionListSearch.worktreeLabel(
                summary("s", worktree = WorktreeMetadata(basePath = "/x", branch = "main", name = "", worktreePath = "/data/github/hapi")),
            ),
        )
        assertNull(SessionListSearch.worktreeLabel(summary("s")))
    }

    // --------------------------------------------------------------- scoring --

    @Test
    fun `exact title beats phrase beats scrambled words`() {
        val fields = SessionListSearch.collectSessionSearchFields(summary("s", name = "Home Assistant Setup"), "")
        val exact = SessionListSearch.scoreSessionSearchFields(fields, listOf("home", "assistant", "setup"), "home assistant setup", wildcard = false)
        val scrambled = SessionListSearch.scoreSessionSearchFields(fields, listOf("setup", "assistant", "home"), "setup assistant home", wildcard = false)
        assertTrue(exact.matched)
        assertTrue(scrambled.matched)
        // Both carry the full-title phrase/exact bonus only for the exact form.
        assertTrue(exact.score > scrambled.score)
        assertEquals(10.0 * 3 * SessionListSearch.BOUNDARY_BONUS + SessionListSearch.EXACT_TITLE_BONUS, exact.score)
    }

    @Test
    fun `multi-token queries AND across terms`() {
        val fields = SessionListSearch.collectSessionSearchFields(summary("s", name = "Home Assistant"), "")
        val both = SessionListSearch.scoreSessionSearchFields(fields, listOf("home", "assistant"), "home assistant", wildcard = false)
        val one = SessionListSearch.scoreSessionSearchFields(fields, listOf("home", "zzz"), "home zzz", wildcard = false)
        assertTrue(both.matched)
        assertFalse(one.matched)
        assertEquals(0.0, one.score)
    }

    @Test
    fun `boundary hit on a lighter field can beat a mid-token hit on a heavier one`() {
        // Summary contains the term mid-token (weight 3, no boundary);
        // machine label contains it on a boundary (weight 2 × 1.75 = 3.5).
        // The best-field pick compares post-bonus contributions, so the
        // machine's 3.5 must win over summary's 3.
        val fields = SessionSearchFixture.fields(summaryText = "Refactor homelab config", machineLabel = "home lab mini")
        val result = SessionListSearch.scoreSessionSearchFields(fields, listOf("home"), "home", wildcard = false)
        assertTrue(result.matched)
        assertEquals(3.5, result.score)
    }

    @Test
    fun `wildcard terms skip the title-phrase bonus only`() {
        val fields = SessionListSearch.collectSessionSearchFields(summary("s", name = "Home Assistant"), "")
        val wildcard = SessionListSearch.scoreSessionSearchFields(fields, listOf("*home*"), "*home*", wildcard = true)
        assertTrue(wildcard.matched)
        // Wildcard hits count as boundary matches (weight × bonus), but the
        // exact-title bonus must not apply to the raw pattern.
        assertEquals(10.0 * SessionListSearch.BOUNDARY_BONUS, wildcard.score)
    }

    // ---------------------------------------------------------------- index --

    @Test
    fun `index ranks a title boundary hit above a path-only match`() {
        val titleHit = summary("title", updatedAt = 100, name = "Home Assistant setup")
        val pathHit = summary("path", updatedAt = 900, name = "Unrelated", path = "/repo/home-lab")
        val index = SessionListSearch.buildSessionSearchScoreIndex(listOf(titleHit, pathHit), "home") { "" }
        assertEquals(setOf("title", "path"), index.matchedIds)
        val ranked = SessionListSearch.sortSessionsBySearchRelevance(listOf(pathHit, titleHit), index)
        assertEquals(listOf("title", "path"), ranked.map { it.id })
    }

    @Test
    fun `blank query builds an empty index and matches everything`() {
        val index = SessionListSearch.buildSessionSearchScoreIndex(listOf(summary("a"), summary("b")), "   ") { "" }
        assertTrue(index.scores.isEmpty())
        assertTrue(index.matchedIds.isEmpty())
        assertTrue(SessionListSearch.sessionMatchesSearchIndex("a", index, hasTextQuery = false))
    }

    @Test
    fun `non-matching ids are excluded from the match set`() {
        val hit = summary("hit", name = "Home Assistant")
        val miss = summary("miss", name = "Totally different")
        val index = SessionListSearch.buildSessionSearchScoreIndex(listOf(hit, miss), "home") { "" }
        assertEquals(setOf("hit"), index.matchedIds)
        assertTrue(SessionListSearch.sessionMatchesSearchIndex("hit", index, hasTextQuery = true))
        assertFalse(SessionListSearch.sessionMatchesSearchIndex("miss", index, hasTextQuery = true))
    }

    @Test
    fun `score ties break by recency`() {
        val older = summary("older", updatedAt = 100, name = "Home one")
        val newer = summary("newer", updatedAt = 900, name = "Home two")
        val index = SessionListSearch.buildSessionSearchScoreIndex(listOf(older, newer), "home") { "" }
        val ranked = SessionListSearch.sortSessionsBySearchRelevance(listOf(older, newer), index)
        assertEquals(listOf("newer", "older"), ranked.map { it.id })
    }

    @Test
    fun `pin-preserving sort keeps pinned rows contiguous ahead of ordinary rows`() {
        val homePinned = summary("home-pinned", updatedAt = 900, name = "Home Assistant", pinned = true)
        val homelabPinned = summary("homelab-pinned", updatedAt = 800, name = "homelab dashboard", pinned = true)
        val home = summary("home", updatedAt = 700, name = "Home automation")
        val homelab = summary("homelab", updatedAt = 600, name = "homelab notes")
        val sessions = listOf(home, homelab, homePinned, homelabPinned)
        val index = SessionListSearch.buildSessionSearchScoreIndex(sessions, "home") { "" }
        val ranked = SessionListSearch.sortSessionsBySearchRelevancePreservingPins(sessions, index)
        // Pinned block first (boundary home beats mid-token homelab), then the
        // same ordering among ordinary rows — no interleaved transitions.
        assertEquals(
            listOf("home-pinned", "homelab-pinned", "home", "homelab"),
            ranked.map { it.id },
        )
    }

    // ------------------------------------------------------ boolean matcher --

    @Test
    fun `sessionMatchesQuery is substring-inclusion AND across terms`() {
        val session = summary("s", name = "Home Assistant", path = "/repo/home-lab", machineId = "m1")
        assertTrue(SessionListSearch.sessionMatchesQuery(session, "home", machineLabel = ""))
        assertTrue(SessionListSearch.sessionMatchesQuery(session, "home assistant", machineLabel = ""))
        // Different fields can satisfy different tokens.
        assertTrue(SessionListSearch.sessionMatchesQuery(session, "home repo", machineLabel = ""))
        assertFalse(SessionListSearch.sessionMatchesQuery(session, "home zzz", machineLabel = ""))
        assertTrue(SessionListSearch.sessionMatchesQuery(session, "", machineLabel = ""))
    }

    @Test
    fun `sessionMatchesQuery supports wildcards across any field`() {
        val session = summary("s", name = "Weekly cleanup", path = "/repo/home-lab")
        assertTrue(SessionListSearch.sessionMatchesQuery(session, "*home?lab", machineLabel = ""))
        assertFalse(SessionListSearch.sessionMatchesQuery(session, "*home?labx", machineLabel = ""))
    }
}

/** Fixture fields for scoring tests whose sessions are not worth building. */
private object SessionSearchFixture {
    fun fields(summaryText: String, machineLabel: String): SessionSearchFields =
        SessionSearchFields(
            title = listOf("Unrelated title"),
            worktreeLabel = emptyList(),
            summary = listOf(summaryText),
            flavor = listOf("claude"),
            machine = listOf(machineLabel),
            path = emptyList(),
            id = listOf("s"),
        )
}
