import Foundation
import HapiClient
import Testing

/// Appearance/language persistence + the mode → appearance resolution the
/// app root applies (system follows the OS scheme, explicit modes override,
/// OLED implies dark).
@MainActor
@Suite("Theme & language prefs")
struct ThemePrefsTests {

    private func makeDefaults() throws -> (UserDefaults, String) {
        let suiteName = "ThemePrefsTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        return (defaults, suiteName)
    }

    // MARK: - ThemePrefs

    @Test func themeModeRoundTripsThroughUserDefaults() throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(ThemePrefs(defaults: defaults).mode == .system)

        ThemePrefs(defaults: defaults).setMode(.oled)
        #expect(ThemePrefs(defaults: defaults).mode == .oled)

        ThemePrefs(defaults: defaults).setMode(.light)
        #expect(ThemePrefs(defaults: defaults).mode == .light)
    }

    @Test func corruptStoredModeDegradesToSystem() throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set("neon", forKey: ThemePrefs.modeKey)
        #expect(ThemePrefs(defaults: defaults).mode == .system)
    }

    @Test func storageKeysAreStable() {
        // Persisted values — renaming them silently resets user choices.
        #expect(ThemeMode.system.storageKey == "system")
        #expect(ThemeMode.light.storageKey == "light")
        #expect(ThemeMode.dark.storageKey == "dark")
        #expect(ThemeMode.oled.storageKey == "oled")
        #expect(AppLanguage.system.storageKey == "system")
        #expect(AppLanguage.english.storageKey == "en")
        #expect(AppLanguage.simplifiedChinese.storageKey == "zh-Hans")
    }

    // MARK: - Resolution

    @Test func systemModeFollowsTheOSScheme() {
        #expect(ThemeMode.system.resolvedAppearance(systemIsDark: false) == .light)
        #expect(ThemeMode.system.resolvedAppearance(systemIsDark: true) == .dark)
    }

    @Test func explicitModesOverrideTheOSScheme() {
        #expect(ThemeMode.light.resolvedAppearance(systemIsDark: true) == .light)
        #expect(ThemeMode.dark.resolvedAppearance(systemIsDark: false) == .dark)
        #expect(ThemeMode.oled.resolvedAppearance(systemIsDark: false) == .oled)
        #expect(ThemeMode.oled.resolvedAppearance(systemIsDark: true) == .oled)
    }

    // MARK: - LanguagePrefs

    @Test func languageRoundTripsThroughUserDefaults() throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(LanguagePrefs(defaults: defaults).language == .system)

        LanguagePrefs(defaults: defaults).setLanguage(.simplifiedChinese)
        #expect(LanguagePrefs(defaults: defaults).language == .simplifiedChinese)

        LanguagePrefs(defaults: defaults).setLanguage(.english)
        #expect(LanguagePrefs(defaults: defaults).language == .english)
    }

    @Test func corruptStoredLanguageDegradesToFollowSystem() throws {
        let (defaults, suiteName) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set("tlh", forKey: LanguagePrefs.languageKey)
        #expect(LanguagePrefs(defaults: defaults).language == .system)
    }

    @Test func languageNamesAreShownInTheirOwnLanguage() {
        #expect(AppLanguage.english.displayName == "English")
        #expect(AppLanguage.simplifiedChinese.displayName == "简体中文")
        // The follow-system row's label is localized at the app layer; the
        // package carries the English source string.
        #expect(AppLanguage.system.displayName == "Follow system")
    }
}
