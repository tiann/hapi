import Foundation
import HapiClient
import Testing

@Suite("Hub URL normalization")
struct HubURLNormalizationTests {
    @Test func normalizesToLowercasedOrigin() {
        #expect(HubURLNormalization.normalize(" https://Hub.Example.com/ ") == "https://hub.example.com")
        #expect(HubURLNormalization.normalize("https://hub.example.com/some/path?q=1#f") == "https://hub.example.com")
        #expect(HubURLNormalization.normalize("HTTP://hub.example.com") == "http://hub.example.com")
    }

    @Test func dropsDefaultPortsKeepsCustomOnes() {
        #expect(HubURLNormalization.normalize("https://hub.example.com:443/") == "https://hub.example.com")
        #expect(HubURLNormalization.normalize("http://hub.example.com:80") == "http://hub.example.com")
        #expect(HubURLNormalization.normalize("http://192.168.1.5:8005/") == "http://192.168.1.5:8005")
    }

    @Test func keepsIPv6Brackets() {
        #expect(HubURLNormalization.normalize("http://[::1]:8005/") == "http://[::1]:8005")
    }

    @Test(arguments: ["", "   ", "hub.example.com", "ftp://hub.example.com", "hapicompanion://bind"])
    func rejectsNonHTTPInputs(raw: String) {
        #expect(HubURLNormalization.normalize(raw) == nil)
    }
}

@Suite("HubRegistry")
struct HubRegistryTests {
    private func makeDefaults() throws -> (UserDefaults, String) {
        let suiteName = "HubRegistryTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        return (defaults, suiteName)
    }

    @Test func registersInOrderAndActivatesFirst() throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let registry = HubRegistry(defaults: defaults)

        #expect(registry.register("https://one.test/") == "https://one.test")
        #expect(registry.register("https://two.test") == "https://two.test")
        // Re-registering (differently formatted) is a no-op.
        #expect(registry.register("https://ONE.test") == "https://one.test")

        #expect(registry.hubs == ["https://one.test", "https://two.test"])
        #expect(registry.activeHub == "https://one.test")
    }

    @Test func invalidURLIsRejected() throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let registry = HubRegistry(defaults: defaults)
        #expect(registry.register("not a url") == nil)
        #expect(registry.hubs.isEmpty)
        #expect(registry.activeHub == nil)
    }

    @Test func switchesAndValidatesActiveHub() throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let registry = HubRegistry(defaults: defaults)
        registry.register("https://one.test")
        registry.register("https://two.test")

        #expect(registry.setActiveHub("https://two.test/"))
        #expect(registry.activeHub == "https://two.test")
        // Unregistered hubs cannot become active.
        #expect(registry.setActiveHub("https://three.test") == false)
        #expect(registry.activeHub == "https://two.test")
    }

    @Test func removalFallsBackToFirstRemainingHub() throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let registry = HubRegistry(defaults: defaults)
        registry.register("https://one.test")
        registry.register("https://two.test")
        registry.setActiveHub("https://two.test")

        registry.remove("https://two.test")
        #expect(registry.hubs == ["https://one.test"])
        #expect(registry.activeHub == "https://one.test")

        registry.remove("https://one.test")
        #expect(registry.hubs.isEmpty)
        #expect(registry.activeHub == nil)
    }
}
