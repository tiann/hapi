package app.hapi.protocol.wire

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class JsonExtensionsTest {

    private val root: JsonElement = Json.parseToJsonElement(
        """
        {
          "session": {
            "id": "sess_1",
            "seq": 42,
            "active": true,
            "updatedAt": 1755400000000,
            "temperature": 0.5,
            "title": null,
            "tags": ["alpha", "beta"]
          },
          "count": "42"
        }
        """
    )

    private val session: JsonElement? get() = root.objOrNull?.get("session")

    @Test
    fun `objOrNull distinguishes objects from other kinds`() {
        assertTrue(root.objOrNull != null)
        assertNull(session.objOrNull?.get("tags").objOrNull)
        assertNull(session.objOrNull?.get("id").objOrNull)
        assertNull((null as JsonElement?).objOrNull)
    }

    @Test
    fun `arrayOrNull distinguishes arrays from other kinds`() {
        val tags = session.objOrNull?.get("tags").arrayOrNull
        assertEquals(2, tags?.size)
        assertEquals("alpha", tags?.get(0).stringOrNull)
        assertNull(root.arrayOrNull)
        assertNull(session.objOrNull?.get("id").arrayOrNull)
    }

    @Test
    fun `stringOrNull only matches real json strings`() {
        assertEquals("sess_1", session.objOrNull?.get("id").stringOrNull)
        assertEquals("42", root.objOrNull?.get("count").stringOrNull)
        // Numbers, booleans, nulls and containers are not strings.
        assertNull(session.objOrNull?.get("seq").stringOrNull)
        assertNull(session.objOrNull?.get("active").stringOrNull)
        assertNull(session.objOrNull?.get("title").stringOrNull)
        assertNull(session.stringOrNull)
    }

    @Test
    fun `intOrNull is strict about type and range`() {
        assertEquals(42, session.objOrNull?.get("seq").intOrNull)
        // A json string "42" is not an int.
        assertNull(root.objOrNull?.get("count").intOrNull)
        // Out of Int range.
        assertNull(session.objOrNull?.get("updatedAt").intOrNull)
        // Non-integral number.
        assertNull(session.objOrNull?.get("temperature").intOrNull)
    }

    @Test
    fun `longOrNull covers 64-bit timestamps`() {
        assertEquals(1_755_400_000_000L, session.objOrNull?.get("updatedAt").longOrNull)
        assertEquals(42L, session.objOrNull?.get("seq").longOrNull)
        assertNull(root.objOrNull?.get("count").longOrNull)
    }

    @Test
    fun `doubleOrNull reads json numbers`() {
        assertEquals(0.5, session.objOrNull?.get("temperature").doubleOrNull)
        assertEquals(42.0, session.objOrNull?.get("seq").doubleOrNull)
        assertNull(root.objOrNull?.get("count").doubleOrNull)
        assertNull(session.objOrNull?.get("active").doubleOrNull)
    }

    @Test
    fun `boolOrNull only matches real json booleans`() {
        assertEquals(true, session.objOrNull?.get("active").boolOrNull)
        assertNull(session.objOrNull?.get("seq").boolOrNull)
        assertNull(root.objOrNull?.get("count").boolOrNull)
        assertNull(session.objOrNull?.get("title").boolOrNull)
    }

    @Test
    fun `json null and absent keys read as null everywhere`() {
        val title = session.objOrNull?.get("title")
        assertNull(title.stringOrNull)
        assertNull(title.objOrNull)
        assertNull(title.arrayOrNull)
        assertNull(title.intOrNull)
        assertNull(title.boolOrNull)

        val missing = session.objOrNull?.get("nope")
        assertNull(missing.stringOrNull)
        assertNull(missing.objOrNull)
        assertNull(missing.intOrNull)
    }

    @Test
    fun `accessors chain without intermediate null checks`() {
        assertEquals("sess_1", root.objOrNull?.get("session").objOrNull?.get("id").stringOrNull)
        assertNull(root.objOrNull?.get("ghost").objOrNull?.get("id").stringOrNull)
    }
}
