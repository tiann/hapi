package app.hapi.protocol.wire

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Wire shapes of the native passkey flow (`docs/api/client-contract/auth.md`
 * §Native passkeys) and the RP-ID guard registration runs first.
 */
class PasskeyApiTest {

    private val creationOptions = """
        {
          "rp": {"id": "auth.hapi.run", "name": "HAPI"},
          "user": {"id": "dXNlcg", "name": "hapi@hub.example", "displayName": "HAPI"},
          "challenge": "Y2hhbGxlbmdl",
          "pubKeyCredParams": [{"type": "public-key", "alg": -7}, {"type": "public-key", "alg": -257}],
          "attestation": "none"
        }
    """.trimIndent()

    // ------------------------------------------------------------ requests --

    @Test
    fun `options request sends client native as the only field`() {
        val body = HapiJson.parseToJsonElement(
            HapiJson.encodeToString(PasskeyOptionsRequest.Native),
        ).jsonObject

        assertEquals(setOf("client"), body.keys)
        assertEquals("native", body.getValue("client").jsonPrimitive.content)
    }

    @Test
    fun `register verify body carries the raw response and an optional name`() {
        val response = HapiJson.parseToJsonElement(
            """{"id":"Y3JlZA","rawId":"Y3JlZA","type":"public-key",""" +
                """"response":{"clientDataJSON":"e30","attestationObject":"e30"}}""",
        )
        val body = HapiJson.parseToJsonElement(
            HapiJson.encodeToString(PasskeyRegisterVerifyRequest(response)),
        ).jsonObject

        assertEquals(setOf("response"), body.keys, "unnamed registration omits name")
        assertEquals(
            "Y3JlZA",
            body.getValue("response").jsonObject.getValue("rawId").jsonPrimitive.content,
        )

        val named = HapiJson.parseToJsonElement(
            HapiJson.encodeToString(PasskeyRegisterVerifyRequest(response, name = "Pixel 9")),
        ).jsonObject
        assertEquals("Pixel 9", named.getValue("name").jsonPrimitive.content)
    }

    @Test
    fun `login verify body carries only the assertion`() {
        val response = HapiJson.parseToJsonElement(
            """{"id":"Y3JlZA","rawId":"Y3JlZA","type":"public-key",""" +
                """"response":{"clientDataJSON":"e30","authenticatorData":"e30",""" +
                """"signature":"e30","userHandle":"dXNlcg"}}""",
        )
        val body = HapiJson.parseToJsonElement(
            HapiJson.encodeToString(PasskeyLoginVerifyRequest(response)),
        ).jsonObject

        assertEquals(setOf("response"), body.keys)
    }

    // ----------------------------------------------------------- responses --

    @Test
    fun `login verify response exposes the jwt and refresh credential`() {
        val parsed = HapiJson.decodeFromString<PasskeyLoginResponse>(
            """{"token":"jwt-1","user":{"id":1,"firstName":"Web User"},"passkeySession":"session-1"}""",
        )

        assertEquals("jwt-1", parsed.token)
        assertEquals(1, parsed.user.id)
        assertEquals("session-1", parsed.passkeySession)
    }

    @Test
    fun `passkey list decodes nulls and tracks validity`() {
        val list = HapiJson.decodeFromString<PasskeyListResponse>(
            """
            {"passkeys":[
              {"id":"native-1","name":"Pixel 9","rpId":"auth.hapi.run","createdAt":1750000000000,
               "lastUsedAt":null,"valid":true},
              {"id":"web-1","name":null,"rpId":"hub.example","createdAt":1750000000001,"valid":false}
            ]}
            """.trimIndent(),
        )

        assertEquals(2, list.passkeys.size)
        val native = list.passkeys[0]
        assertEquals("Pixel 9", native.name)
        assertEquals(NativePasskeys.RP_ID, native.rpId)
        assertNull(native.lastUsedAt)
        assertTrue(native.valid)
        val web = list.passkeys[1]
        assertNull(web.name)
        assertEquals(false, web.valid)
        assertNull(web.lastUsedAt, "absent lastUsedAt decodes to null")
    }

    // ------------------------------------------------------------- rp guard --

    @Test
    fun `reads the declared relying party from creation options`() {
        assertEquals("auth.hapi.run", NativePasskeys.creationRpId(creationOptions))
        NativePasskeys.requireCreationRpId(creationOptions)
    }

    @Test
    fun `rejects options for a different or missing relying party`() {
        val foreign = creationOptions.replace("\"auth.hapi.run\"", "\"evil.example\"")
        val mismatch = assertFailsWith<PasskeyRpMismatchException> {
            NativePasskeys.requireCreationRpId(foreign)
        }
        assertEquals("auth.hapi.run", mismatch.expected)
        assertEquals("evil.example", mismatch.actual)

        val missing = assertFailsWith<PasskeyRpMismatchException> {
            NativePasskeys.requireCreationRpId("""{"challenge":"e30"}""")
        }
        assertNull(missing.actual)

        assertFailsWith<PasskeyRpMismatchException> {
            NativePasskeys.requireCreationRpId("not json")
        }
    }

    @Test
    fun `credential response drops top-level nulls the hub schema rejects`() {
        val sanitized = NativePasskeys.credentialResponse(
            """
            {"id":"Y3JlZA","rawId":"Y3JlZA","type":"public-key",
             "authenticatorAttachment":null,"clientExtensionResults":{},
             "response":{"clientDataJSON":"e30"}}
            """.trimIndent(),
        )

        assertNull(sanitized["authenticatorAttachment"])
        assertTrue("authenticatorAttachment" !in sanitized.keys)
        assertEquals(setOf("id", "rawId", "type", "clientExtensionResults", "response"), sanitized.keys)
        assertFailsWith<IllegalArgumentException> { NativePasskeys.credentialResponse("[]") }
    }

    @Test
    fun `names are trimmed and clamped to the hub limit`() {
        assertNull(NativePasskeys.normalizeName("   "))
        assertNull(NativePasskeys.normalizeName(null))
        assertEquals("Pixel 9", NativePasskeys.normalizeName("  Pixel 9  "))
        assertEquals(
            NativePasskeys.MAX_NAME_LENGTH,
            NativePasskeys.normalizeName("x".repeat(200))?.length,
        )
    }
}
