import Foundation

/// A `(wire value, display label)` pair for the create-form option pickers.
public struct NewSessionOption: Equatable, Hashable, Sendable {
    public let value: String
    public let label: String

    public init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

/// Static option catalogs for the new-session form. The claude rows are
/// **derived** from `ClaudeModels` / `ClaudeEfforts` (issue #39: one source
/// of truth shared with `ModelCatalog`'s composer builders) rather than
/// duplicating the preset/label tables. Only the codex reasoning list is its
/// own data — a port of the web `CODEX_REASONING_EFFORT_OPTIONS`
/// (`web/src/components/NewSession/types.ts`; the web drops `max` for codex
/// — `EffortField.tsx`). Android keeps a feature-local copy
/// (`NewSessionCatalogs.kt`); here the catalogs live in one package so the
/// pure form logic and the app UI share one source.
public enum NewSessionCatalogs {
    /// `'auto'` sentinel row uses the web's "Default" label; preset rows come
    /// from `ClaudeModels` in picker order.
    public static let claudeModels: [NewSessionOption] =
        [NewSessionOption(value: "auto", label: "Default")]
            + ClaudeModels.presets.map {
                NewSessionOption(value: $0, label: ClaudeModels.label(for: $0) ?? $0)
            }

    /// `'auto'` sentinel row, then the `ClaudeEfforts` levels in ascending
    /// order.
    public static let claudeEfforts: [NewSessionOption] =
        [NewSessionOption(value: "auto", label: "Auto")]
            + ClaudeEfforts.levels.map {
                NewSessionOption(value: $0, label: ClaudeEfforts.label(for: $0) ?? effortLabel($0))
            }

    /// Static codex fallback when the model row advertises no efforts
    /// (the web drops `max` for codex — `EffortField.tsx`).
    public static let codexReasoningEfforts: [NewSessionOption] = [
        NewSessionOption(value: "default", label: "Default"),
        NewSessionOption(value: "low", label: "Low"),
        NewSessionOption(value: "medium", label: "Medium"),
        NewSessionOption(value: "high", label: "High"),
        NewSessionOption(value: "xhigh", label: "XHigh"),
    ]

    /// Capitalized label for a server-advertised effort id (`high` → `High`).
    public static func effortLabel(_ value: String) -> String {
        ModelCatalog.capitalizedFirst(value)
    }
}
