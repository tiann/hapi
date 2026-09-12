package app.hapi.data.push

import java.io.File
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class PushEnvelopeTest {
    private val key = ByteArray(32) { it.toByte() }

    private fun encrypt(text: String, aad: String = "hapi-push-v1"): String {
        val nonce = ByteArray(12) { it.toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad.toByteArray(Charsets.US_ASCII))
        return Base64.getEncoder().encodeToString(nonce + cipher.doFinal(text.toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun `matches the same normative vector as hub and iOS`() {
        val file = File(System.getProperty("hapi.fixtures.dir"), "push/envelope-v1.json")
        val vector = Json.parseToJsonElement(file.readText()).jsonObject
        val vectorKey = vector.getValue("key_hex").jsonPrimitive.content.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val plaintext = vector.getValue("plaintext").jsonPrimitive.content
        val envelope = vector.getValue("envelope_b64").jsonPrimitive.content
        assertContentEquals(key, vectorKey)
        assertEquals(plaintext, PushEnvelope.decrypt(envelope, vectorKey).toString(Charsets.UTF_8))
        assertEquals(envelope, encrypt(plaintext))
    }

    @Test
    fun `rejects tampering wrong keys wrong AAD and malformed envelopes`() {
        val valid = encrypt("{}")
        val raw = Base64.getDecoder().decode(valid)
        for (index in listOf(0, 12, raw.lastIndex)) {
            val tampered = raw.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
            assertFails { PushEnvelope.decrypt(Base64.getEncoder().encodeToString(tampered), key) }
        }
        assertFails { PushEnvelope.decrypt(valid, ByteArray(32) { 5 }) }
        assertFails { PushEnvelope.decrypt(valid, ByteArray(31)) }
        assertFails { PushEnvelope.decrypt(encrypt("{}", "wrong-aad"), key) }
        for (envelope in listOf("", "not base64!", "QUJDRA==", "A".repeat(3204))) {
            assertFails { PushEnvelope.decrypt(envelope, key) }
        }
    }

    @Test
    fun `encrypted and direct pushes retain the same rendering and actions`() {
        val decoder = PushMessageDecoder { key }
        for (type in listOf("permission-request", "ready", "task-notification")) {
            val plain = mapOf("type" to type, "sessionId" to "s1", "requestId" to "r1", "contractVersion" to "1",
                "title" to "请求权限", "body" to "完成 😀", "severity" to "warning")
            val encrypted = mapOf("hapi_v" to "1", "hapi_e" to encrypt(Json.encodeToString(plain)))
            val payload = decoder.decode(encrypted)
            assertEquals(PushPayload.parse(plain), payload)
            assertTrue(payload!!.supportsActions)
            assertEquals("$type-s1", payload.notificationTag)
            assertEquals(PushPayload.parse(plain), PushMessageDecoder { error("plain path must not read a key") }.decode(plain))
        }
    }

    @Test
    fun `encrypted markers cannot downgrade to plaintext and missing keys never render`() {
        val forged = mapOf("sessionId" to "spoof", "title" to "spoof")
        val decoder = PushMessageDecoder { key }
        for (marker in listOf(
            mapOf("hapi_v" to "2"), mapOf("hapi_e" to encrypt("{}")), mapOf("hapi_v" to "1"),
            mapOf("hapi_v" to "1", "hapi_e" to "broken"),
            mapOf("hapi_v" to "1", "hapi_e" to encrypt("{\"sessionId\":123}")),
            mapOf("hapi_v" to "1", "hapi_e" to encrypt("not json")),
        )) assertNull(decoder.decode(forged + marker))
        val valid = mapOf("hapi_v" to "1", "hapi_e" to encrypt("{\"sessionId\":\"s1\"}"))
        assertNull(PushMessageDecoder { null }.decode(valid))
        assertNull(PushMessageDecoder { error("Keystore unavailable") }.decode(valid))
    }
}
