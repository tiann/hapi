package app.hapi.protocol.wire

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class FollowUpWireTest {
    @Test
    fun `interactive send encodes the follow-up intent on its own`() {
        for ((intent, wire) in listOf(
            FollowUpIntent.Default to "default",
            FollowUpIntent.Queue to "queue",
            FollowUpIntent.Steer to "steer",
        )) {
            val request = SendMessageRequest("hello", followUpIntent = intent)
            val encoded = HapiJson.encodeToString(SendMessageRequest.serializer(), request)
            val fields = HapiJson.parseToJsonElement(encoded).jsonObject
            assertEquals(wire, fields.getValue("followUpIntent").jsonPrimitive.content)
            assertNull(fields["deliveryMode"])
        }
    }

    @Test
    fun `older hub settings default to queue and newer hubs can choose steer`() {
        val legacy = HapiJson.decodeFromString(HubSettingsResponse.serializer(), "{}")
        val configured = HapiJson.decodeFromString(HubSettingsResponse.serializer(), """{"followUpDefault":"steer"}""")
        assertEquals("queue", legacy.followUpDefault)
        assertEquals("steer", configured.followUpDefault)
    }
}
