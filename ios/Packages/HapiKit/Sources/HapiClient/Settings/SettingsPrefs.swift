import Foundation
import Observation

/// Theme choice (web `ThemeMode` twin; Android
/// `feature/settings/ThemePrefs.kt`). ``oled`` is the pure-black variant — it
/// implies dark and maps to the HapiUI `.oled` palette at the app's root.
public enum ThemeMode: String, CaseIterable, Sendable {
    case system
    case light
    case dark
    case oled

    /// Unknown/corrupt stored values degrade to ``system``.
    public init(storageKey: String?) {
        self = storageKey.flatMap(ThemeMode.init(rawValue:)) ?? .system
    }

    public var storageKey: String { rawValue }

    /// The palette this mode resolves to: ``system`` follows the OS
    /// appearance, explicit modes override it.
    public func resolvedAppearance(systemIsDark: Bool) -> ResolvedAppearance {
        switch self {
        case .system: return systemIsDark ? .dark : .light
        case .light: return .light
        case .dark: return .dark
        case .oled: return .oled
        }
    }
}

/// The appearance a ``ThemeMode`` resolves to for a given system scheme.
/// The app maps this to the HapiUI palette (`.light` / `.dark` / `.oled`)
/// and to `preferredColorScheme`; kept SwiftUI-free here so it is testable.
public enum ResolvedAppearance: Equatable, Sendable {
    case light
    case dark
    case oled
}

/// App language choice (web `Locale` twin plus a follow-system default).
///
/// A-M5 wires the selection to an `AppleLanguages` override at the app layer
/// (explicit picks pin the app locale, ``system`` removes the override);
/// this type only persists the choice.
public enum AppLanguage: String, CaseIterable, Sendable {
    case system = "system"
    case english = "en"
    case simplifiedChinese = "zh-Hans"

    /// Unknown/corrupt/absent stored values degrade to ``system``.
    public init(storageKey: String?) {
        self = storageKey.flatMap(AppLanguage.init(rawValue:)) ?? .system
    }

    public var storageKey: String { rawValue }

    /// Explicit language names are shown in their own language (standard
    /// picker convention). ``system``'s label is UI copy — the app layer
    /// localizes it at the display point (this package stays language-free).
    public var displayName: String {
        switch self {
        case .system: return "Follow system"
        case .english: return "English"
        case .simplifiedChinese: return "简体中文"
        }
    }
}

/// Appearance persistence over `UserDefaults` (app-wide, like the Android
/// `hapi_prefs` DataStore). Read at the app root to drive the HapiUI palette,
/// written by the settings screen; unreadable values degrade to defaults.
@MainActor @Observable
public final class ThemePrefs {
    public private(set) var mode: ThemeMode

    // `let` storage is inert under @Observable (no annotation needed).
    private let defaults: UserDefaults

    public static let modeKey = "settings.themeMode"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.mode = ThemeMode(storageKey: defaults.string(forKey: Self.modeKey))
    }

    public func setMode(_ mode: ThemeMode) {
        self.mode = mode
        defaults.set(mode.storageKey, forKey: Self.modeKey)
    }
}

/// Language persistence over `UserDefaults` (persist-only until M5).
@MainActor @Observable
public final class LanguagePrefs {
    public private(set) var language: AppLanguage

    private let defaults: UserDefaults

    public static let languageKey = "settings.appLanguage"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.language = AppLanguage(storageKey: defaults.string(forKey: Self.languageKey))
    }

    public func setLanguage(_ language: AppLanguage) {
        self.language = language
        defaults.set(language.storageKey, forKey: Self.languageKey)
    }
}
