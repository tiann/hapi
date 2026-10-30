package app.hapi.protocol.wire

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Decoding of `GET /api/hub-settings` and encoding of the PUT patch — the
 * owner-only switches behind Settings → General. Upstream carries only the
 * two sessionSummary fields; `autoTitlePerTurn` / `disablePeerTools` are
 * fork extensions (unmerged upstream), so an upstream response omits them
 * and the client must decode it with both null (UI hides those sections).
 */
class HubSettingsDecodingTest {

    @Test
    fun `decodes the fork shape with all four switches`() {
        val settings = HapiJson.decodeFromString(
            HubSettings.serializer(),
            """
            {
              "sessionSummaryContract": true,
              "sessionSummaryInChat": false,
              "autoTitlePerTurn": true,
              "disablePeerTools": false
            }
            """,
        )
        assertTrue(settings.sessionSummaryContract)
        assertFalse(settings.sessionSummaryInChat)
        assertEquals(true, settings.autoTitlePerTurn)
        assertEquals(false, settings.disablePeerTools)
    }

    @Test
    fun `upstream shape decodes with the fork extensions null`() {
        val settings = HapiJson.decodeFromString(
            HubSettings.serializer(),
            """{"sessionSummaryContract": false, "sessionSummaryInChat": true}""",
        )
        assertFalse(settings.sessionSummaryContract)
        assertTrue(settings.sessionSummaryInChat)
        assertNull(settings.autoTitlePerTurn)
        assertNull(settings.disablePeerTools)
    }

    @Test
    fun `unknown keys from a newer hub are ignored`() {
        val settings = HapiJson.decodeFromString(
            HubSettings.serializer(),
            """
            {
              "sessionSummaryContract": false,
              "sessionSummaryInChat": false,
              "autoTitlePerTurn": false,
              "disablePeerTools": true,
              "someFutureSwitch": true
            }
            """,
        )
        assertEquals(false, settings.autoTitlePerTurn)
        assertEquals(true, settings.disablePeerTools)
    }

    @Test
    fun `PUT patch omits unset fields`() {
        // `explicitNulls = false`: a single-field patch serializes to exactly
        // that field, satisfying the hub's "at least one field" refine.
        val json = HapiJson.encodeToString(
            UpdateHubSettingsRequest.serializer(),
            UpdateHubSettingsRequest(autoTitlePerTurn = true),
        )
        assertEquals("""{"autoTitlePerTurn":true}""", json)
    }

    @Test
    fun `empty PATCH serializes to an empty object`() {
        val json = HapiJson.encodeToString(
            UpdateHubSettingsRequest.serializer(),
            UpdateHubSettingsRequest(),
        )
        assertEquals("{}", json)
    }
}
