package app.hapi.companion.feature.chat.composer

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ParkDraftEligibleTest {

    // The composer Park quick action (and the former overflow item) renders
    // only when the scratchlist feature is on and there is text to park.

    @Test
    fun `park action needs the feature on and a non-blank draft`() {
        assertTrue(parkDraftEligible(scratchlistEnabled = true, draftText = "half-written plan"))
    }

    @Test
    fun `feature off hides the action even with a draft`() {
        assertFalse(parkDraftEligible(scratchlistEnabled = false, draftText = "half-written plan"))
    }

    @Test
    fun `blank drafts have nothing to park`() {
        assertFalse(parkDraftEligible(scratchlistEnabled = true, draftText = ""))
        assertFalse(parkDraftEligible(scratchlistEnabled = true, draftText = "   \n\t "))
    }
}
