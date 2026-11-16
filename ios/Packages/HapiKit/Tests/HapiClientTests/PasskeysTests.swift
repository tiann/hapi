import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Native passkey wire encoding (`docs/api/client-contract/auth.md#passkeys-native`).
/// The hub verifies the payload cryptographically, so these pin the JSON
/// shape the app produces against `hub/src/web/routes/passkey.test.ts`.
@Suite("Passkeys")
struct PasskeysTests {
    private func registrationOptionsJSON(
        rpId: String = "hapi.run",
        userID: String = Base64URL.encode(Data("handle".utf8)),
        challenge: String = Base64URL.encode(Data("challenge-bytes".utf8)),
        exclude: [String] = []
    ) -> String {
        let excluded = exclude.map { "{\"id\":\"\($0)\",\"type\":\"public-key\",\"transports\":[\"internal\"]}" }
        return """
        {"challenge":"\(challenge)","rp":{"id":"\(rpId)","name":"HAPI"},
         "user":{"id":"\(userID)","name":"hapi@hub.example.com","displayName":"HAPI · hub.example.com"},
         "pubKeyCredParams":[{"alg":-7,"type":"public-key"}],
         "excludeCredentials":[\(excluded.joined(separator: ","))],
         "authenticatorSelection":{"residentKey":"required","userVerification":"required"},
         "attestation":"none"}
        """
    }

    private func assertionOptionsJSON(rpId: String = "hapi.run", credentials: [String] = []) -> String {
        let allowed = credentials.map { "{\"id\":\"\($0)\",\"type\":\"public-key\",\"transports\":[\"internal\"]}" }
        return """
        {"challenge":"\(Base64URL.encode(Data("challenge-bytes".utf8)))","rpId":"\(rpId)",
         "allowCredentials":[\(allowed.joined(separator: ","))],"userVerification":"required"}
        """
    }

    // MARK: - base64url

    @Test func base64urlRoundTripsWithoutPadding() throws {
        let bytes = Data([0xFB, 0xFF, 0x00, 0x10, 0x7F])
        let encoded = Base64URL.encode(bytes)
        #expect(!encoded.contains("+") && !encoded.contains("/") && !encoded.contains("="))
        #expect(encoded == "-_8AEH8")
        #expect(Base64URL.decode(encoded) == bytes)
        // Padded input decodes too.
        #expect(Base64URL.decode("-_8AEH8=") == bytes)
        // Length 1 mod 4 is not a valid base64url string.
        #expect(Base64URL.decode("abcde") == nil)
    }

    // MARK: - Options decoding

    @Test func registrationRequestDecodesBase64URLFields() throws {
        let options = try HapiJSON.decoder.decode(
            PasskeyRegistrationOptions.self,
            from: Data(registrationOptionsJSON(exclude: ["Y3JlZDE"]).utf8)
        )
        let request = try PasskeyRegistrationRequest(options: options)
        #expect(request.relyingPartyID == "hapi.run")
        #expect(request.challenge == Data("challenge-bytes".utf8))
        #expect(request.userID == Data("handle".utf8))
        #expect(request.userName == "hapi@hub.example.com")
        #expect(request.excludedCredentialIDs == [Data("cred1".utf8)])
    }

    @Test func registrationRejectsForeignRelyingParty() throws {
        let options = try HapiJSON.decoder.decode(
            PasskeyRegistrationOptions.self,
            from: Data(registrationOptionsJSON(rpId: "hub.example.com").utf8)
        )
        #expect(throws: PasskeyError.relyingPartyMismatch("hub.example.com")) {
            _ = try PasskeyRegistrationRequest(options: options)
        }
    }

    @Test func registrationRejectsMissingRelyingParty() throws {
        let json = registrationOptionsJSON(rpId: "hapi.run").replacingOccurrences(of: "\"id\":\"hapi.run\"", with: "\"id\":\"\"")
        let options = try HapiJSON.decoder.decode(PasskeyRegistrationOptions.self, from: Data(json.utf8))
        #expect(throws: PasskeyError.relyingPartyMismatch("")) {
            _ = try PasskeyRegistrationRequest(options: options)
        }
    }

    @Test func assertionRequestDecodesAllowList() throws {
        let options = try HapiJSON.decoder.decode(
            PasskeyAssertionOptions.self,
            from: Data(assertionOptionsJSON(credentials: ["Y3JlZDE"]).utf8)
        )
        let request = try PasskeyAssertionRequest(options: options)
        #expect(request.relyingPartyID == "hapi.run")
        #expect(request.challenge == Data("challenge-bytes".utf8))
        #expect(request.allowedCredentialIDs == [Data("cred1".utf8)])
    }

    @Test func assertionRejectsForeignRelyingParty() throws {
        let options = try HapiJSON.decoder.decode(
            PasskeyAssertionOptions.self,
            from: Data(assertionOptionsJSON(rpId: "evil.example").utf8)
        )
        #expect(throws: PasskeyError.relyingPartyMismatch("evil.example")) {
            _ = try PasskeyAssertionRequest(options: options)
        }
    }

    // MARK: - Response encoding

    @Test func registrationResponseMatchesHubShape() throws {
        let result = PasskeyRegistrationResult(
            credentialID: Data("credential-id".utf8),
            clientDataJSON: Data("{\"type\":\"webauthn.create\"}".utf8),
            attestationObject: Data([0xA3])
        )
        let body = try HapiJSON.encoder.encode(PasskeyRegistrationResponseJSON(result))
        let object = try #require(
            try JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        let id = Base64URL.encode(Data("credential-id".utf8))
        #expect(object["id"] as? String == id)
        #expect(object["rawId"] as? String == id)
        #expect(object["type"] as? String == "public-key")
        #expect(object["authenticatorAttachment"] as? String == "platform")
        #expect((object["clientExtensionResults"] as? [String: Any])?.isEmpty == true)
        let response = try #require(object["response"] as? [String: Any])
        #expect(response["clientDataJSON"] as? String == Base64URL.encode(Data("{\"type\":\"webauthn.create\"}".utf8)))
        #expect(response["attestationObject"] as? String == "ow")
        #expect(response["transports"] as? [String] == ["internal", "hybrid"])
        // No padding anywhere: the hub decodes base64url.
        #expect(!String(decoding: body, as: UTF8.self).contains("="))
    }

    @Test func assertionResponseMatchesHubShape() throws {
        let result = PasskeyAssertionResult(
            credentialID: Data("credential-id".utf8),
            clientDataJSON: Data("{\"type\":\"webauthn.get\"}".utf8),
            authenticatorData: Data([0x01, 0x02]),
            signature: Data([0x03, 0x04]),
            userID: Data("handle".utf8)
        )
        let body = try HapiJSON.encoder.encode(PasskeyAssertionResponseJSON(result))
        let object = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let response = try #require(object["response"] as? [String: Any])
        #expect(object["id"] as? String == Base64URL.encode(Data("credential-id".utf8)))
        #expect(response["authenticatorData"] as? String == "AQI")
        #expect(response["signature"] as? String == "AwQ")
        #expect(response["userHandle"] as? String == Base64URL.encode(Data("handle".utf8)))
        #expect(object["type"] as? String == "public-key")
        #expect(object["authenticatorAttachment"] as? String == "platform")
    }

    @Test func assertionWithoutUserHandleOmitsIt() throws {
        let result = PasskeyAssertionResult(
            credentialID: Data("id".utf8),
            clientDataJSON: Data("{}".utf8),
            authenticatorData: Data([0x01]),
            signature: Data([0x02]),
            userID: nil
        )
        let body = try HapiJSON.encoder.encode(PasskeyAssertionResponseJSON(result))
        let object = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let response = try #require(object["response"] as? [String: Any])
        #expect(response["userHandle"] == nil)
    }

    // MARK: - Summaries

    @Test func passkeySummaryDecodesListResponse() throws {
        let json = """
        {"passkeys":[
          {"id":"abc","name":"iPhone","rpId":"hapi.run","createdAt":1700000000000,"lastUsedAt":1700000100000,"valid":true},
          {"id":"def","name":null,"rpId":"hub.example.com","createdAt":1700000000000,"lastUsedAt":null,"valid":false}
        ]}
        """
        let response = try HapiJSON.decoder.decode(PasskeyListResponse.self, from: Data(json.utf8))
        #expect(response.passkeys.count == 2)
        #expect(response.passkeys[0].isNative)
        #expect(response.passkeys[0].lastUsedDate == Date(timeIntervalSince1970: 1_700_000_100))
        #expect(response.passkeys[1].isNative == false)
        #expect(response.passkeys[1].lastUsedDate == nil)
        #expect(response.passkeys[1].valid == false)
    }

    // MARK: - Endpoints

    @Test func registrationOptionsRequestSendsNativeClient() async throws {
        let harness = try makeHarness(paired: true, jwt: freshJWT())
        await harness.performer.enqueue(json: registrationOptionsJSON())
        _ = try await harness.client.passkeyRegistrationOptions()
        let requests = await harness.performer.requests
        let request = try #require(requests.first)
        #expect(request.url?.absoluteString == "\(testHubURLString)/api/passkey/register/options")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(freshJWT())")
        let body = try #require(request.httpBody.flatMap { String(data: $0, encoding: .utf8) })
        #expect(body == "{\"client\":\"native\"}")
    }

    @Test func loginOptionsIsUnauthenticatedAndMapsNoPasskeys() async throws {
        let harness = try makeHarness(paired: false)
        await harness.performer.enqueue(status: 404, json: "{\"error\":\"no_passkeys\"}")
        let error = await capturedError { try await harness.client.passkeyLoginOptions() }
        #expect(error as? PasskeyError == .noPasskeys)
        let requests = await harness.performer.requests
        let request = try #require(requests.first)
        #expect(request.url?.absoluteString == "\(testHubURLString)/api/passkey/login/options")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(request.httpBody.flatMap { String(data: $0, encoding: .utf8) } == "{\"client\":\"native\"}")
    }

    @Test func loginVerifyPostsResponseEnvelope() async throws {
        let harness = try makeHarness(paired: false)
        let assertion = PasskeyAssertionResult(
            credentialID: Data("credential-id".utf8),
            clientDataJSON: Data("{\"type\":\"webauthn.get\"}".utf8),
            authenticatorData: Data([0x01]),
            signature: Data([0x02]),
            userID: nil
        )
        await harness.performer.enqueue(json: "{\"token\":\"jwt\",\"user\":{\"id\":1},\"passkeySession\":\"ps\"}")
        let login = try await harness.client.verifyPasskeyLogin(PasskeyAssertionResponseJSON(assertion))
        #expect(login.token == "jwt")
        #expect(login.passkeySession == "ps")
        let requests = await harness.performer.requests
        let request = try #require(requests.first)
        #expect(request.url?.absoluteString == "\(testHubURLString)/api/passkey/login/verify")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        let body = try #require(request.httpBody)
        let object = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let response = try #require(object["response"] as? [String: Any])
        #expect(response["id"] as? String == Base64URL.encode(Data("credential-id".utf8)))
    }

    @Test func registerVerifySendsResponseAndClampedName() async throws {
        let harness = try makeHarness(paired: true, jwt: freshJWT())
        let result = PasskeyRegistrationResult(
            credentialID: Data("id".utf8),
            clientDataJSON: Data("{}".utf8),
            attestationObject: Data([0x01])
        )
        let longName = String(repeating: "a", count: 80)
        await harness.performer.enqueue(json: "{\"ok\":true}")
        try await harness.client.verifyPasskeyRegistration(PasskeyRegistrationResponseJSON(result), name: longName)
        let requests = await harness.performer.requests
        let request = try #require(requests.first)
        #expect(request.url?.absoluteString == "\(testHubURLString)/api/passkey/register/verify")
        let body = try #require(request.httpBody)
        let object = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect((object["name"] as? String)?.count == 64)
        #expect(object["response"] != nil)
    }

    @Test func listAndDeletePasskeys() async throws {
        let harness = try makeHarness(paired: true, jwt: freshJWT())
        await harness.performer.enqueue(json: "{\"passkeys\":[]}")
        await harness.performer.enqueue(json: "{\"ok\":true}")
        let list = try await harness.client.listPasskeys()
        #expect(list.isEmpty)
        try await harness.client.deletePasskey(id: "a/b")
        let requests = await harness.performer.requests
        #expect(requests[0].url?.absoluteString == "\(testHubURLString)/api/passkeys")
        #expect(requests[1].httpMethod == "DELETE")
        #expect(requests[1].url?.absoluteString == "\(testHubURLString)/api/passkeys/a%2Fb")
    }

    @Test func registerPasskeyRunsCeremonyAndVerifies() async throws {
        let harness = try makeHarness(paired: true, jwt: freshJWT())
        let authenticator = ScriptedAuthenticator(
            registration: PasskeyRegistrationResult(
                credentialID: Data("id".utf8),
                clientDataJSON: Data("{}".utf8),
                attestationObject: Data([0x01])
            )
        )
        await harness.performer.enqueue(json: registrationOptionsJSON())
        await harness.performer.enqueue(json: "{\"ok\":true}")
        try await harness.client.registerPasskey(name: "  iPad  ", using: authenticator)
        let seen = await authenticator.registrations
        #expect(seen.count == 1)
        #expect(seen.first?.challenge == Data("challenge-bytes".utf8))
        let requests = await harness.performer.requests
        #expect(requests.count == 2)
        let body = try #require(requests[1].httpBody)
        let object = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(object["name"] as? String == "iPad")
    }

    @Test func registerPasskeyDoesNotVerifyWhenCanceled() async throws {
        let harness = try makeHarness(paired: true, jwt: freshJWT())
        let authenticator = ScriptedAuthenticator(registrationError: PasskeyError.canceled)
        await harness.performer.enqueue(json: registrationOptionsJSON())
        let error = await capturedError {
            try await harness.client.registerPasskey(name: "x", using: authenticator)
        }
        #expect(error as? PasskeyError == .canceled)
        let count = await harness.performer.requests.count
        #expect(count == 1)
    }
}

// MARK: - Scripted platform

/// Records the platform requests and answers with a fixed result (or error).
actor ScriptedAuthenticator: PasskeyAuthenticating {
    private(set) var registrations: [PasskeyRegistrationRequest] = []
    private(set) var assertions: [PasskeyAssertionRequest] = []

    private let registrationResult: PasskeyRegistrationResult
    private let registrationError: (any Error & Sendable)?
    private let assertionResult: PasskeyAssertionResult
    private let assertionError: (any Error & Sendable)?

    init(
        registration: PasskeyRegistrationResult = PasskeyRegistrationResult(
            credentialID: Data("id".utf8),
            clientDataJSON: Data("{}".utf8),
            attestationObject: Data([0x01])
        ),
        registrationError: (any Error & Sendable)? = nil,
        assertion: PasskeyAssertionResult = PasskeyAssertionResult(
            credentialID: Data("id".utf8),
            clientDataJSON: Data("{}".utf8),
            authenticatorData: Data([0x01]),
            signature: Data([0x02]),
            userID: nil
        ),
        assertionError: (any Error & Sendable)? = nil
    ) {
        self.registrationResult = registration
        self.registrationError = registrationError
        self.assertionResult = assertion
        self.assertionError = assertionError
    }

    func register(_ request: PasskeyRegistrationRequest) async throws -> PasskeyRegistrationResult {
        registrations.append(request)
        if let registrationError { throw registrationError }
        return registrationResult
    }

    func authenticate(_ request: PasskeyAssertionRequest) async throws -> PasskeyAssertionResult {
        assertions.append(request)
        if let assertionError { throw assertionError }
        return assertionResult
    }
}
