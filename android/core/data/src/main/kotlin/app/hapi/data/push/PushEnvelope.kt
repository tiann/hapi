package app.hapi.data.push

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** iOS-compatible envelope: base64(nonce[12] || ciphertext || tag[16]). */
object PushEnvelope {
    fun decrypt(envelope: String, key: ByteArray): ByteArray {
        require(key.size == 32) { "Invalid push key length" }
        require(envelope.isNotEmpty() && envelope.length <= 3200 && envelope.length % 4 == 0) { "Invalid push envelope length" }
        val raw = Base64.getDecoder().decode(envelope)
        require(raw.size >= 28) { "Truncated push envelope" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
        cipher.updateAAD("hapi-push-v1".toByteArray(Charsets.US_ASCII))
        return cipher.doFinal(raw, 12, raw.size - 12)
    }
}

/** A present encrypted marker never falls back to trusting plaintext fields. */
class PushMessageDecoder(private val existingKey: () -> ByteArray?) {
    fun decode(data: Map<String, String>): PushPayload? {
        if ("hapi_v" !in data && "hapi_e" !in data) return PushPayload.parse(data)
        if (data["hapi_v"] != "1") return null
        return try {
            val envelope = data["hapi_e"] ?: return null
            val key = existingKey() ?: return null
            val fields = Json.parseToJsonElement(PushEnvelope.decrypt(envelope, key).toString(Charsets.UTF_8)).jsonObject
            val plaintext = fields.mapValues { (_, value) ->
                (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            }
            PushPayload.parse(plaintext)
        } catch (_: Exception) {
            // Do not log the key, envelope, decrypted content or parser exception.
            null
        }
    }
}
