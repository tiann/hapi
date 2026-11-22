package app.hapi.protocol.wire

import java.security.MessageDigest
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

class PasskeyHubBindingTest {
    private val hub = "https://hub.example.com"
    private val b64 = Base64.getUrlEncoder().withoutPadding()

    private fun options(origin: String = hub, operation: String = "register", channel: String = "native", accountHub: String = origin): String {
        val challenge = b64.encodeToString("""{"v":1,"hub":"$origin","id":"${"a".repeat(43)}","nonce":"${"b".repeat(43)}","operation":"$operation","channel":"$channel"}""".toByteArray())
        val authority = java.net.URI(accountHub).rawAuthority.toByteArray()
        val user = b64.encodeToString(byteArrayOf(2, authority.size.toByte()) + authority + ByteArray(16))
        return """{"challenge":"$challenge","rp":{"id":"auth.hapi.run"},"user":{"id":"$user","name":"hapi@hub.example.com"}}"""
    }

    private fun handleFor(origin: String): ByteArray {
        val authority = java.net.URI(origin).rawAuthority.toByteArray()
        return byteArrayOf(2, authority.size.toByte()) + authority + ByteArray(16) { 7 }
    }

    /** Long-address handle: [2, 0, SHA-256(origin), 16-byte tag]. */
    private fun opaqueHandleFor(origin: String): ByteArray =
        byteArrayOf(2, 0) + MessageDigest.getInstance("SHA-256").digest(origin.toByteArray()) + ByteArray(16) { 7 }

    private fun assertion(handle: ByteArray?): String {
        val userHandle = handle?.let { ""","userHandle":"${b64.encodeToString(it)}"""" }.orEmpty()
        return """{"id":"Y3JlZA","response":{"clientDataJSON":"e30"$userHandle}}"""
    }

    @Test fun `only supported fields reach the credential provider`() {
        val input = options().dropLast(1) + """, "userVerification":"discouraged", "extensions":{"prf":{}}, "authenticatorSelection":{"residentKey":"discouraged"}}"""
        val checked = NativePasskeys.registrationOptions(input, hub)
        assertFalse(checked.contains("extensions"))
        assertFalse(checked.contains("discouraged"))
        assertEquals(true, checked.contains("required"))
    }

    @Test fun `validates registration and canonical default port`() {
        NativePasskeys.requireHubBinding(options(), "https://HUB.example.com:443/")
        NativePasskeys.requireHubBinding(options(), hub)
    }

    @Test fun `refuses forwarded challenges and wrong channels before the system UI`() {
        for (input in listOf(options(origin = "https://other.example"), options(operation = "login"), options(channel = "browser"), "{}")) {
            assertFailsWith<Exception> { NativePasskeys.requireHubBinding(input, hub) }
        }
    }

    @Test fun `refuses account handles belonging to another Hub`() {
        assertFailsWith<Exception> {
            NativePasskeys.requireHubBinding(options(accountHub = "https://other.example"), hub)
        }
    }

    @Test fun `locator vector matches Web and Swift and enforces the canonical origin`() {
        val handle = byteArrayOf(2, 8) + "hub.test".toByteArray() + ByteArray(16) { 1 }
        assertEquals("02086875622e7465737401010101010101010101010101010101", handle.joinToString("") { "%02x".format(it) })
        assertEquals("https://hub.test", NativePasskeys.userHandleHub(handle))
        for (origin in listOf("https://hub.test:8443", "https://[2001:db8::1]:8443")) {
            val authority = java.net.URI(origin).rawAuthority.toByteArray()
            assertEquals(origin, NativePasskeys.userHandleHub(byteArrayOf(2, authority.size.toByte()) + authority + ByteArray(16)))
        }
        for (authority in listOf("HUB.test", "hub.test:443", "hub.test/path", "u:p@hub.test", "hub.test?x", "hub.test#x", "hub.test/")) {
            assertFailsWith<Exception> {
                NativePasskeys.userHandleHub(byteArrayOf(2, authority.length.toByte()) + authority.toByteArray() + ByteArray(16))
            }
        }
        assertEquals(null, NativePasskeys.userHandleHub(byteArrayOf(2, 0) + ByteArray(48)))
        assertFailsWith<Exception> { NativePasskeys.userHandleHub(ByteArray(64)) }
    }

    @Test fun `native login challenge matches the shared v2 shape`() {
        val now = 1_763_000_000_123L
        val options = HapiJson.parseToJsonElement(NativePasskeys.nativeLoginOptions(now)).jsonObject
        assertEquals(setOf("challenge", "rpId", "userVerification", "timeout"), options.keys, "no allowCredentials or extensions")
        assertEquals("auth.hapi.run", options.getValue("rpId").jsonPrimitive.content)
        assertEquals("required", options.getValue("userVerification").jsonPrimitive.content)
        assertEquals(120000L, options.getValue("timeout").jsonPrimitive.long)

        val encoded = options.getValue("challenge").jsonPrimitive.content
        assertTrue(encoded.matches(Regex("[A-Za-z0-9_-]+")), "base64url without padding")
        val challenge = HapiJson.parseToJsonElement(String(Base64.getUrlDecoder().decode(encoded), Charsets.UTF_8)).jsonObject
        assertEquals(setOf("v", "operation", "channel", "iat", "nonce"), challenge.keys)
        assertEquals(2, challenge.getValue("v").jsonPrimitive.int)
        assertTrue(!challenge.getValue("v").jsonPrimitive.isString)
        assertEquals("login", challenge.getValue("operation").jsonPrimitive.content)
        assertEquals("native", challenge.getValue("channel").jsonPrimitive.content)
        assertEquals(now, challenge.getValue("iat").jsonPrimitive.long)
        assertTrue(!challenge.getValue("iat").jsonPrimitive.isString)
        val nonce = challenge.getValue("nonce").jsonPrimitive.content
        assertTrue(nonce.matches(Regex("[A-Za-z0-9_-]{43}")), nonce)
        assertEquals(32, Base64.getUrlDecoder().decode(nonce).size)

        assertNotEquals(NativePasskeys.nativeLoginOptions(now), NativePasskeys.nativeLoginOptions(now), "fresh nonce per call")
    }

    @Test fun `login Hub comes from the selected credential`() {
        assertEquals("https://hub.test", NativePasskeys.loginHub(assertion(handleFor("https://hub.test")), null))
        assertEquals("https://hub.test:8443", NativePasskeys.loginHub(assertion(handleFor("https://hub.test:8443")), null))
    }

    @Test fun `missing or opaque handles without an address require manual entry`() {
        for (bad in listOf(
            "{}", """{"response":{"userHandle":null}}""", """{"response":{"userHandle":"YQ"}}""",
            """{"response":{"userHandle":"!!"}}""", assertion(null), assertion(opaqueHandleFor(hub)),
        )) {
            assertFailsWith<PasskeyHubAddressRequiredException>(bad) { NativePasskeys.loginHub(bad, null) }
        }
    }

    @Test fun `an entered Hub must own the selected credential`() {
        assertEquals(hub, NativePasskeys.loginHub(assertion(handleFor(hub)), "https://HUB.example.com:443"))
        assertEquals(hub, NativePasskeys.loginHub(assertion(opaqueHandleFor(hub)), hub))
        for (bad in listOf(
            assertion(handleFor("https://other.example")), assertion(opaqueHandleFor("https://other.example")),
            assertion(null), "{}",
        )) {
            val error = assertFailsWith<PasskeyHubMismatchException>(bad) { NativePasskeys.loginHub(bad, hub) }
            assertEquals(hub, error.expectedHub)
        }
    }
}
