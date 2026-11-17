package app.hapi.companion.feature.passkey

/** Scripted [PasskeyPlatform]: records the options it was handed. */
class FakePasskeyPlatform : PasskeyPlatform {
    val createRequests = mutableListOf<String>()
    val getRequests = mutableListOf<String>()

    var createResult: (String) -> String = {
        """{"id":"Y3JlZA","rawId":"Y3JlZA","type":"public-key","authenticatorAttachment":null,""" +
            """"response":{"clientDataJSON":"e30","attestationObject":"e30"},"clientExtensionResults":{}}"""
    }
    var getResult: (String) -> String = { passkeyAssertion(null) }

    override suspend fun createPasskey(requestJson: String): String {
        createRequests += requestJson
        return createResult(requestJson)
    }

    override suspend fun getPasskey(requestJson: String): String {
        getRequests += requestJson
        return getResult(requestJson)
    }
}

/** Hub-issued v1 registration options; production validates them before platform UI. */
fun boundRegistrationOptions(hub: String): String {
    val b64 = java.util.Base64.getUrlEncoder().withoutPadding()
    val challenge = b64.encodeToString(
        """{"v":1,"hub":"$hub","id":"${"a".repeat(43)}","nonce":"${"b".repeat(43)}","operation":"register","channel":"native"}""".toByteArray(),
    )
    val user = b64.encodeToString(passkeyUserHandle(hub))
    return """{"challenge":"$challenge","rp":{"id":"auth.hapi.run"},"user":{"id":"$user","name":"hapi@${java.net.URI(hub).rawAuthority}"}}"""
}

/** v2 discoverable user handle: [2, authority length, authority, 16-byte tag]. */
fun passkeyUserHandle(hub: String): ByteArray {
    val authority = java.net.URI(hub).rawAuthority.toByteArray()
    return byteArrayOf(2, authority.size.toByte()) + authority + ByteArray(16) { 1 }
}

/** v2 long-address user handle: [2, 0, SHA-256(origin), 16-byte tag]. */
fun opaquePasskeyUserHandle(hub: String): ByteArray =
    byteArrayOf(2, 0) + java.security.MessageDigest.getInstance("SHA-256").digest(hub.toByteArray()) + ByteArray(16) { 1 }

/** An `AuthenticationResponseJSON` whose credential carries [userHandle]. */
fun passkeyAssertion(userHandle: ByteArray?): String {
    val handle = userHandle?.let {
        ""","userHandle":"${java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(it)}""""
    }.orEmpty()
    return """{"id":"Y3JlZA","rawId":"Y3JlZA","type":"public-key",""" +
        """"response":{"clientDataJSON":"e30","authenticatorData":"e30","signature":"e30"$handle}}"""
}
