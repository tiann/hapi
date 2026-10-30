package app.hapi.companion.feature.sessions

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest

/**
 * Pure encode/decode rules for the group-collapse blob (web
 * `collapseOverrides` Map twin) plus the in-memory fake's write-through —
 * the DataStore-backed behavior mirrors `DirectoryExpandPrefsTest`'s
 * round-trip via the same Preferences mechanics, so the pure layer is the
 * drift risk this file pins.
 */
class SessionGroupCollapsePrefsTest {

    @Test
    fun `encode emits a json object of group keys to booleans and decode restores it`() {
        val overrides = mapOf(
            "m1::/repo/app" to true,
            "m2::/repo/lib" to false,
        )
        assertEquals(
            """{"m1::/repo/app":true,"m2::/repo/lib":false}""",
            SessionGroupCollapsePrefs.encode(overrides),
        )
        assertEquals(overrides, SessionGroupCollapsePrefs.decode(SessionGroupCollapsePrefs.encode(overrides)))
    }

    @Test
    fun `decode degrades corrupt payloads to the empty map`() {
        assertEquals(emptyMap(), SessionGroupCollapsePrefs.decode(null))
        assertEquals(emptyMap(), SessionGroupCollapsePrefs.decode("not json at all"))
        assertEquals(emptyMap(), SessionGroupCollapsePrefs.decode("""["m1::/repo/app"]"""))
        assertEquals(emptyMap(), SessionGroupCollapsePrefs.decode("42"))
        // Non-boolean values drop out; boolean ones survive.
        assertEquals(
            mapOf("m1::/repo/app" to true),
            SessionGroupCollapsePrefs.decode("""{"m1::/repo/app":true,"bogus":"yes","nada":null}"""),
        )
    }

    @Test
    fun `in-memory fake writes overrides through and keeps explicit false`() = runTest {
        val prefs = InMemorySessionGroupCollapsePrefs()
        assertTrue(prefs.overrides("hub-a").first().isEmpty())

        prefs.setOverride("hub-a", "m1::/repo/app", true)
        prefs.setOverride("hub-a", "m2::/repo/lib", false)
        assertEquals(
            mapOf("m1::/repo/app" to true, "m2::/repo/lib" to false),
            prefs.overrides("hub-a").first(),
        )
        // Explicit false is a recorded choice, not a return to the default.
        prefs.setOverride("hub-a", "m1::/repo/app", false)
        assertEquals(
            mapOf("m1::/repo/app" to false, "m2::/repo/lib" to false),
            prefs.overrides("hub-a").first(),
        )
    }
}
