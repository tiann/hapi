package app.hapi.companion.feature.passkey

/** Scripted [PasskeyPlatform]: records the options it was handed. */
class FakePasskeyPlatform : PasskeyPlatform {
    val createRequests = mutableListOf<String>()
    val getRequests = mutableListOf<String>()

    var createResult: (String) -> String = {
        """{"id":"Y3JlZA","rawId":"Y3JlZA","type":"public-key","authenticatorAttachment":null,""" +
            """"response":{"clientDataJSON":"e30","attestationObject":"e30"},"clientExtensionResults":{}}"""
    }
    var getResult: (String) -> String = {
        """{"id":"Y3JlZA","rawId":"Y3JlZA","type":"public-key",""" +
            """"response":{"clientDataJSON":"e30","authenticatorData":"e30","signature":"e30"}}"""
    }

    override suspend fun createPasskey(requestJson: String): String {
        createRequests += requestJson
        return createResult(requestJson)
    }

    override suspend fun getPasskey(requestJson: String): String {
        getRequests += requestJson
        return getResult(requestJson)
    }
}

/** The production clients must validate these envelopes before platform UI. */
fun boundPasskeyOptions(hub: String, operation: String): String {
    val b64 = java.util.Base64.getUrlEncoder().withoutPadding()
    val challenge = b64.encodeToString(
        """{"v":1,"hub":"$hub","id":"${"a".repeat(43)}","nonce":"${"b".repeat(43)}","operation":"$operation","channel":"native"}""".toByteArray(),
    )
    if (operation == "login") return """{"challenge":"$challenge","rpId":"auth.hapi.run","allowCredentials":[{"id":"Y3JlZA","type":"public-key"}]}"""
    val prefix = java.security.MessageDigest.getInstance("SHA-256").digest(hub.toByteArray())
    val user = b64.encodeToString(prefix + ByteArray(32) { 1 })
    return """{"challenge":"$challenge","rp":{"id":"auth.hapi.run"},"user":{"id":"$user","name":"hapi@${java.net.URI(hub).rawAuthority}"}}"""
}
