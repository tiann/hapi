import Foundation

/// Agent flavor id.
///
/// Ports `AGENT_FLAVORS` (`shared/src/modes.ts:10`) plus the capability /
/// label tables from `shared/src/flavors.ts`. Unknown wire values are
/// preserved in `.other` so a newer hub never crashes decoding — they behave
/// like TS's failed `isKnownFlavor` check (no capabilities, "Unknown" label,
/// Claude permission-mode fallback).
public enum AgentFlavor: Equatable, Hashable, Sendable {
    case agy
    case claude
    case codex
    case dsh
    case copilot
    case cursor
    case gemini
    case grok
    case kimi
    case opencode
    case pi
    case other(String)

    /// Order matches `AGENT_FLAVORS`.
    public static let knownFlavors: [AgentFlavor] = [
        .agy, .claude, .codex, .dsh, .copilot, .cursor, .gemini, .grok, .kimi, .opencode, .pi,
    ]

    /// Flavors offered when creating a new session (`CREATABLE_AGENT_FLAVORS`).
    /// Gemini is excluded: the consumer Gemini CLI was sunset, but stored
    /// Gemini sessions remain viewable.
    public static let creatableFlavors: [AgentFlavor] = knownFlavors.filter { $0 != .gemini }

    public var isKnown: Bool {
        if case .other = self { return false }
        return true
    }
}

extension AgentFlavor: RawRepresentable {
    public init(rawValue: String) {
        switch rawValue {
        case "agy": self = .agy
        case "claude": self = .claude
        case "codex": self = .codex
        case "dsh": self = .dsh
        case "copilot": self = .copilot
        case "cursor": self = .cursor
        case "gemini": self = .gemini
        case "grok": self = .grok
        case "kimi": self = .kimi
        case "opencode": self = .opencode
        case "pi": self = .pi
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .agy: return "agy"
        case .claude: return "claude"
        case .codex: return "codex"
        case .dsh: return "dsh"
        case .copilot: return "copilot"
        case .cursor: return "cursor"
        case .gemini: return "gemini"
        case .grok: return "grok"
        case .kimi: return "kimi"
        case .opencode: return "opencode"
        case .pi: return "pi"
        case .other(let raw): return raw
        }
    }
}

extension AgentFlavor: Codable {
    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

// MARK: - Labels and capabilities (shared/src/flavors.ts)

extension AgentFlavor {
    /// Display name (`FLAVOR_LABELS`); `"Unknown"` for `.other`, mirroring
    /// `getFlavorLabel`.
    public var displayLabel: String {
        switch self {
        case .agy: return "Antigravity"
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .dsh: return "DeepSeek Harness"
        case .copilot: return "Copilot"
        case .cursor: return "Cursor"
        case .gemini: return "Gemini"
        case .grok: return "Grok Build"
        case .kimi: return "Kimi"
        case .opencode: return "OpenCode"
        case .pi: return "Pi"
        case .other: return "Unknown"
        }
    }

    /// `hasCapability(flavor, 'model-change')` — false for DSH's server-owned
    /// model selection and unknown flavors.
    public var supportsModelChange: Bool {
        switch self {
        case .dsh, .other: return false
        default: return true
        }
    }

    /// `hasCapability(flavor, 'effort')` — claude, grok, and pi only.
    public var supportsEffort: Bool {
        switch self {
        case .claude, .grok, .pi: return true
        default: return false
        }
    }

    /// `isCodexFamilyFlavor` — flavors speaking the generic codex envelope
    /// protocol variants.
    public var isCodexFamily: Bool {
        switch self {
        case .codex, .gemini, .grok, .kimi, .copilot, .opencode: return true
        default: return false
        }
    }
}

/// String-based mirror of `getFlavorLabel(flavor)` for raw
/// `metadata.flavor` values (`nil`/unknown → `"Unknown"`).
public func flavorLabel(forFlavor flavor: String?) -> String {
    guard let flavor else { return "Unknown" }
    return AgentFlavor(rawValue: flavor).displayLabel
}

/// String-based mirror of `supportsModelChange(flavor)` (`nil`/unknown → false).
public func supportsModelChange(forFlavor flavor: String?) -> Bool {
    guard let flavor else { return false }
    return AgentFlavor(rawValue: flavor).supportsModelChange
}

/// String-based mirror of `supportsEffort(flavor)` (`nil`/unknown → false).
public func supportsEffort(forFlavor flavor: String?) -> Bool {
    guard let flavor else { return false }
    return AgentFlavor(rawValue: flavor).supportsEffort
}

/// String-based mirror of `isCodexFamilyFlavor(flavor)`.
public func isCodexFamilyFlavor(_ flavor: String?) -> Bool {
    guard let flavor else { return false }
    return AgentFlavor(rawValue: flavor).isCodexFamily
}
