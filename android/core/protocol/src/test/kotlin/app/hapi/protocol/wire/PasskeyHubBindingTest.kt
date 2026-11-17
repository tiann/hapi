package app.hapi.protocol.wire

import java.security.MessageDigest
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith

class PasskeyHubBindingTest {
    private val hub = "https://hub.example.com"
    private fun options(origin: String = hub, operation: String = "login", channel: String = "native", accountHub: String = origin): String {
        val b64 = Base64.getUrlEncoder().withoutPadding()
        val challenge = b64.encodeToString("""{"v":1,"hub":"$origin","id":"${"a".repeat(43)}","nonce":"${"b".repeat(43)}","operation":"$operation","channel":"$channel"}""".toByteArray())
        val authority = java.net.URI(accountHub).rawAuthority.toByteArray()
        val user = b64.encodeToString(byteArrayOf(2, authority.size.toByte()) + authority + ByteArray(16))
        return """{"challenge":"$challenge","allowCredentials":[{"id":"Y3JlZA"}],"user":{"id":"$user","name":"hapi@hub.example.com"}}"""
    }

    @Test fun `only supported fields reach the credential provider`() {
        val input = options().dropLast(1) + """, "rpId":"auth.hapi.run", "userVerification":"discouraged", "extensions":{"prf":{}}}"""
        val checked = NativePasskeys.ceremonyOptions(input, hub, "login")
        assertFalse(checked.contains("extensions"))
        assertFalse(checked.contains("discouraged"))
        assertEquals(true, checked.contains("required"))
    }

    @Test fun `validates both operations and canonical default port`() {
        NativePasskeys.requireHubBinding(options(), "https://HUB.example.com:443/", "login")
        NativePasskeys.requireHubBinding(options(operation = "register"), hub, "register")
    }

    @Test fun `refuses forwarded challenges and wrong channels before the system UI`() {
        for (input in listOf(options(origin = "https://other.example"), options(operation = "register"), options(channel = "browser"), "{}")) {
            assertFailsWith<Exception> { NativePasskeys.requireHubBinding(input, hub, "login") }
        }
    }

    @Test fun `refuses account handles belonging to another Hub`() {
        assertFailsWith<Exception> {
            NativePasskeys.requireHubBinding(options(operation = "register", accountHub = "https://other.example"), hub, "register")
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

    @Test fun `discovery is a local locator ceremony not a Hub login challenge`() {
        val options = HapiJson.parseToJsonElement(NativePasskeys.discoveryOptions()).toString()
        val parsed = HapiJson.parseToJsonElement(options) as kotlinx.serialization.json.JsonObject
        val challenge = String(Base64.getUrlDecoder().decode(parsed.getValue("challenge").toString().trim('"')))
        assertEquals(true, challenge.contains("discover"))
        assertFalse(options.contains("allowCredentials"))
        assertFalse(options.contains("extensions"))
        assertEquals(false, NativePasskeys.discoveryOptions() == options)
        assertFailsWith<Exception> { NativePasskeys.requireHubBinding(options, hub, "login") }
        val user = Base64.getUrlEncoder().withoutPadding().encodeToString(byteArrayOf(2, 8) + "hub.test".toByteArray() + ByteArray(16))
        assertEquals("https://hub.test", NativePasskeys.discoveredHub("""{"response":{"userHandle":"$user"}}"""))
        for (bad in listOf("{}", """{"response":{"userHandle":null}}""", """{"response":{"userHandle":"YQ"}}""")) {
            assertFailsWith<PasskeyDiscoveryUnavailableException> { NativePasskeys.discoveredHub(bad) }
        }
    }

}
