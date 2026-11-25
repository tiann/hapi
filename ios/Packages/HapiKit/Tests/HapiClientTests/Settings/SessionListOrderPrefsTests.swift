import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Sort key + Active first persist app-wide; defaults are absent keys.
@MainActor
@Suite("Session list order prefs")
struct SessionListOrderPrefsTests {
    private func makeDefaults() throws -> (UserDefaults, String) {
        let suiteName = "SessionListOrderPrefsTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        return (defaults, suiteName)
    }

    @Test func choicesRoundTripAndDefaultsStayAbsent() throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(SessionListOrderPrefs(defaults: defaults).order == .default)

        let prefs = SessionListOrderPrefs(defaults: defaults)
        prefs.setSort(.created)
        prefs.setActiveFirst(false)
        #expect(prefs.order == SessionListOrder(sort: .created, activeFirst: false))
        #expect(SessionListOrderPrefs(defaults: defaults).order == prefs.order)
        #expect(defaults.string(forKey: SessionListOrderPrefs.sortKey) == "created")

        prefs.reset()
        #expect(prefs.order == .default)
        #expect(defaults.object(forKey: SessionListOrderPrefs.sortKey) == nil)
        #expect(defaults.object(forKey: SessionListOrderPrefs.activeFirstKey) == nil)
    }

    @Test func unknownStoredSortDegradesToDefault() throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        // Web dropped an "activity" sort; a stray value must not stick.
        defaults.set("activity", forKey: SessionListOrderPrefs.sortKey)
        #expect(SessionListOrderPrefs(defaults: defaults).order.sort == .lastMessage)
    }

    @Test func inMemoryPrefsNeverPersist() {
        let prefs = SessionListOrderPrefs(defaults: nil)
        prefs.setSort(.created)
        #expect(prefs.order.sort == .created)
        #expect(SessionListOrderPrefs(defaults: nil).order == .default)
    }
}
