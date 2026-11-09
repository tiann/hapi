package app.hapi.companion.feature.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * CursorMigrationBanner state machine (port of
 * `web/src/components/CursorMigrationBanner.tsx` predicates; tiann/hapi#873):
 * metadata-only source, `in_progress` → spinner, `ambiguous` → manual
 * review, everything else (absent, cleared, unknown future value) → no
 * banner.
 */
class CursorMigrationBannerTest {

    @Test
    fun `in_progress maps to the upgrading banner`() {
        assertEquals(CursorMigrationBannerState.InProgress, cursorMigrationBannerState("in_progress"))
    }

    @Test
    fun `ambiguous maps to the manual-review banner`() {
        assertEquals(CursorMigrationBannerState.Ambiguous, cursorMigrationBannerState("ambiguous"))
    }

    @Test
    fun `absent and cleared metadata render no banner`() {
        assertNull(cursorMigrationBannerState(null))
        assertNull(cursorMigrationBannerState(""))
    }

    @Test
    fun `unknown future values render no banner`() {
        // The hub clears the flag in the same metadata write that flips
        // cursorSessionProtocol; any value this build does not know stays
        // opaque — never a half-rendered banner.
        assertNull(cursorMigrationBannerState("done"))
        assertNull(cursorMigrationBannerState("IN_PROGRESS"))
        assertNull(cursorMigrationBannerState("in-progress"))
    }
}
