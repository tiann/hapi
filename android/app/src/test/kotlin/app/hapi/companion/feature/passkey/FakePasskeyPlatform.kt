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
