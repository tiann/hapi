package app.hapi.protocol.patch

import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionPatches
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/** Replays a generated SSE fold so the native reply-clock port stays aligned with the web reference. */
class SseFixtureTest {
    @Test
    fun `reply clock backward and null fixture matches generated fold`() {
        val fixturesDir = File(requireNotNull(System.getProperty("hapi.fixtures.dir")))
        val root = HapiJson.parseToJsonElement(
            File(fixturesDir, "sse/reply-clock-versioned-backward-and-null.json").readText()
        ).jsonObject
        var session = HapiJson.decodeFromJsonElement(
            Session.serializer(),
            root.getValue("initialSession")
        )
        val expectedResults = root.getValue("expectedPatchResults").jsonArray
        val patches = root.getValue("patches").jsonArray
        for (index in patches.indices) {
            val patch = assertNotNull(SessionPatches.parse(patches[index]))
            val next = applySessionDetailPatch(session, patch)
            val result = expectedResults[index].toString().trim('"')
            if (result == "applied") {
                session = assertNotNull(next)
            } else {
                assertEquals("unchanged", result)
                assertNull(next)
            }
        }
        val expected = HapiJson.decodeFromJsonElement(
            Session.serializer(),
            root.getValue("expectedSession")
        )
        assertEquals(expected, session)
    }
}
