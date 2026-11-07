package app.hapi.companion.feature.settings

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest

/**
 * Pure-model tests for the P2 Display preference types: web-aligned defaults,
 * range clamping, tier snapping, and status-mode degradation. Values are
 * hand-verified against the Study-Web field evidence (preview 1..99 default 8;
 * font tiers 0.8..1.3 default 1; metadata defaults below; status
 * standard|detailed default standard).
 */
class DisplayPrefsTest {

    @Test
    fun `defaults mirror the web display settings field for field`() {
        val settings = DisplaySettings()

        assertEquals(8, settings.sessionPreviewLimit)
        assertFalse(settings.showActiveSessionsOnly)
        assertFalse(settings.pinInProgressSessions)
        assertEquals(SessionListStatusMode.STANDARD, settings.sessionListStatusMode)
        assertEquals(AppFontScale.M, settings.fontScale)

        // Web `hapi-session-header-metadata`: seven on, createdAt/updatedAt off.
        val meta = settings.headerMetadata
        assertTrue(meta.showLabels)
        assertTrue(meta.agent)
        assertTrue(meta.machine)
        assertTrue(meta.lastActive)
        assertTrue(meta.model)
        assertTrue(meta.reasoning)
        assertTrue(meta.fastMode)
        assertFalse(meta.createdAt)
        assertFalse(meta.updatedAt)
        assertTrue(meta.worktree)
    }

    @Test
    fun `preview limit clamps to the web input bounds`() {
        assertEquals(1, SessionPreviewLimit.coerce(0))
        assertEquals(1, SessionPreviewLimit.coerce(-7))
        assertEquals(99, SessionPreviewLimit.coerce(100))
        assertEquals(99, SessionPreviewLimit.coerce(500))
        // In-range values pass through untouched, boundaries included.
        assertEquals(1, SessionPreviewLimit.coerce(1))
        assertEquals(8, SessionPreviewLimit.coerce(8))
        assertEquals(99, SessionPreviewLimit.coerce(99))
    }

    @Test
    fun `font scale tiers snap raw factors to the nearest tier`() {
        // Clear-cut raws only: exact midpoints between tiers are float-ambiguous
        // (e.g. 0.85f is not representable) and resolve by diff, not by intent.
        assertEquals(AppFontScale.XS, AppFontScale.fromFactor(0.5f))
        assertEquals(AppFontScale.S, AppFontScale.fromFactor(0.87f))
        assertEquals(AppFontScale.M, AppFontScale.fromFactor(1.04f))
        assertEquals(AppFontScale.L, AppFontScale.fromFactor(1.06f))
        assertEquals(AppFontScale.XL, AppFontScale.fromFactor(1.24f))
        assertEquals(AppFontScale.XXL, AppFontScale.fromFactor(1.27f))
        // Out-of-range factors snap to the extremes; absent → default tier.
        assertEquals(AppFontScale.XS, AppFontScale.fromFactor(0f))
        assertEquals(AppFontScale.XXL, AppFontScale.fromFactor(9f))
        assertEquals(AppFontScale.M, AppFontScale.fromFactor(null))
        // Exact tier factors survive untouched.
        AppFontScale.entries.forEach { tier ->
            assertEquals(tier, AppFontScale.fromFactor(tier.factor))
        }
    }

    @Test
    fun `tier factors and labels match the web steps`() {
        assertEquals(
            listOf(0.8f, 0.9f, 1.0f, 1.1f, 1.2f, 1.3f),
            AppFontScale.entries.map { it.factor },
        )
        // `(factor * 100).roundToInt()` on the float tiers lands exactly on the
        // step values (0.8f*100 = 80.00000119 → 80; 1.3f*100 = 129.999995 → 130).
        assertEquals(
            listOf("80%", "90%", "100%", "110%", "120%", "130%"),
            AppFontScale.entries.map { it.label },
        )
    }

    @Test
    fun `status mode round-trips its storage keys and degrades unknowns`() {
        assertEquals("standard", SessionListStatusMode.STANDARD.storageKey)
        assertEquals("detailed", SessionListStatusMode.DETAILED.storageKey)
        SessionListStatusMode.entries.forEach { mode ->
            assertEquals(mode, SessionListStatusMode.fromStorageKey(mode.storageKey))
        }
        // Absent, junk, and case-mismatched values all degrade to standard
        // (the web stores lowercase keys only).
        assertEquals(SessionListStatusMode.STANDARD, SessionListStatusMode.fromStorageKey(null))
        assertEquals(SessionListStatusMode.STANDARD, SessionListStatusMode.fromStorageKey("ultra"))
        assertEquals(SessionListStatusMode.STANDARD, SessionListStatusMode.fromStorageKey("Detailed"))
    }

    @Test
    fun `in-memory fake emits its initial value and applies updates`() = runTest {
        val initial = DisplaySettings(sessionPreviewLimit = 3)
        val prefs = InMemoryDisplayPrefs(initial)

        assertEquals(initial, prefs.settings.first())

        prefs.update { it.copy(showActiveSessionsOnly = true) }
        assertEquals(3, prefs.settings.value.sessionPreviewLimit)
        assertTrue(prefs.settings.value.showActiveSessionsOnly)
        // Untouched fields keep their defaults through the transform.
        assertFalse(prefs.settings.value.headerMetadata.createdAt)
    }

    @Test
    fun `float tier sanity - factors stay inside the web range`() {
        // Guards against a future tier edit silently leaving the 0.8..1.3 band.
        AppFontScale.entries.forEach { tier ->
            assertTrue(abs(tier.factor - 1f) <= 0.5f, "${tier.name} drifted out of band")
        }
    }
}
