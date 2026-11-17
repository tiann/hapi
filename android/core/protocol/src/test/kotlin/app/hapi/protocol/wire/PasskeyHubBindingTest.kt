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
        val user = b64.encodeToString(MessageDigest.getInstance("SHA-256").digest(accountHub.toByteArray()) + ByteArray(32))
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
}
