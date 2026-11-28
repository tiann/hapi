import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HapiClient

struct CloudflareAccessTests {
    @Test func applicationTokenStaysOnItsHTTPSOrigin() throws {
        let hub = try #require(URL(string: "https://hub.test"))
        let token = "header.payload.signature"
        let access = try #require(CloudflareAccess(hubURL: hub, token: token))
        let original = access.authorize(URLRequest(url: hub))
        #expect(original.value(forHTTPHeaderField: "CF-Access-Token") == token)

        let sameOrigin = URLRequest(url: try #require(URL(string: "https://hub.test:443/api/events")))
        #expect(CloudflareAccess.redirectedRequest(from: original, to: sameOrigin)?
            .value(forHTTPHeaderField: "CF-Access-Token") == token)

        for address in ["http://hub.test", "https://hub.test:8443", "https://other.test"] {
            let request = URLRequest(url: try #require(URL(string: address)))
            #expect(access.authorize(request).value(forHTTPHeaderField: "CF-Access-Token") == nil)
            #expect(CloudflareAccess.redirectedRequest(from: original, to: request) == nil)
        }
        #expect(CloudflareAccess(hubURL: hub, token: "header.payload.signature\r\nNew-Header: x") == nil)
    }

    @Test func refreshingHapiAuthKeepsTheNewerCloudflareCredential() async throws {
        let hub = try #require(URL(string: "https://hub.test"))
        let store = InMemoryCredentialStore()
        let performer = RecordingPerformer()
        let original = HubCredentials(
            hubUrl: hub.absoluteString,
            credential: .accessToken("hapi-token"),
            cloudflareAccessToken: "header.payload.original"
        )
        try store.store(original)
        let auth = AuthManager(baseURL: hub, credentialStore: store, performer: performer)
        var renewed = original
        renewed.cloudflareAccessToken = "header.payload.renewed"
        try store.store(renewed)
        let issued = freshJWT()
        await performer.enqueue(json: authResponseJSON(token: issued))

        #expect(try await auth.validToken() == issued)

        let requests = await performer.requests
        #expect(requests.first?.value(forHTTPHeaderField: "CF-Access-Token") == original.cloudflareAccessToken)
        #expect(try store.credentials(forHub: hub.absoluteString) == renewed)
    }
}
