import Foundation

/// Visual weight of a permission mode in pickers.
///
/// Ports `PermissionModeTone` (`shared/src/modes.ts`).
public enum PermissionModeTone: String, Codable, Sendable {
    case neutral
    case info
    case warning
    case danger
}

/// Union of every flavor's permission mode ids.
///
/// Ports `PERMISSION_MODES` (`shared/src/modes.ts:52-66`); declaration order
/// matches the TS array. Labels and tones port
/// `PERMISSION_MODE_LABELS` / `PERMISSION_MODE_TONES` verbatim (English —
/// localization is an M5 concern layered above the catalog).
public enum PermissionMode: String, Codable, CaseIterable, Sendable {
    case `default`
    case acceptEdits
    case auto
    case bypassPermissions
    case plan
    case ask
    case debug
    case autoReview
    case readOnly = "read-only"
    case safeYolo = "safe-yolo"
    case yolo
    case requestReview = "request-review"
    case alwaysProceed = "always-proceed"

    public var label: String {
        switch self {
        case .default: return "Default"
        case .acceptEdits: return "Accept Edits"
        case .auto: return "Auto"
        case .bypassPermissions: return "Yolo"
        case .plan: return "Plan Mode"
        case .ask: return "Ask Mode"
        case .debug: return "Debug Mode"
        case .autoReview: return "Auto-review"
        case .readOnly: return "Read Only"
        case .safeYolo: return "Safe Yolo"
        case .yolo: return "Yolo"
        case .requestReview: return "Request Review"
        case .alwaysProceed: return "Always Proceed"
        }
    }

    public var tone: PermissionModeTone {
        switch self {
        case .default: return .neutral
        case .acceptEdits: return .warning
        case .auto: return .warning
        case .bypassPermissions: return .danger
        case .plan: return .info
        case .ask: return .info
        case .debug: return .info
        case .autoReview: return .warning
        case .readOnly: return .warning
        case .safeYolo: return .warning
        case .yolo: return .danger
        case .requestReview: return .neutral
        case .alwaysProceed: return .danger
        }
    }
}

/// A picker-ready permission mode entry (`PermissionModeOption`).
public struct PermissionModeOption: Equatable, Sendable {
    public let mode: PermissionMode
    public let label: String
    public let tone: PermissionModeTone

    public init(mode: PermissionMode) {
        self.mode = mode
        self.label = mode.label
        self.tone = mode.tone
    }
}

extension AgentFlavor {
    /// Permission modes offered for this flavor, in picker order.
    ///
    /// Ports the per-flavor arrays in `shared/src/modes.ts`
    /// (`getPermissionModesForFlavor`): unknown flavors fall back to the
    /// Claude set, and Pi offers none (its RPC mode always auto-approves).
    public var permissionModes: [PermissionMode] {
        switch self {
        case .codex, .gemini, .kimi, .copilot:
            return [.default, .readOnly, .safeYolo, .yolo]
        case .grok:
            return [.default, .auto, .plan, .bypassPermissions]
        case .opencode:
            return [.default, .plan, .yolo]
        case .dsh:
            return []
        case .agy:
            return [.requestReview, .alwaysProceed]
        case .cursor:
            return [.default, .plan, .ask, .debug, .autoReview, .yolo]
        case .pi:
            return []
        case .claude, .other:
            return [.default, .acceptEdits, .auto, .bypassPermissions, .plan]
        }
    }
}

/// String-based mirror of `getPermissionModesForFlavor(flavor)`:
/// `nil` and unknown flavors yield the Claude set.
public func permissionModes(forFlavor flavor: String?) -> [PermissionMode] {
    AgentFlavor(rawValue: flavor ?? "claude").permissionModes
}

/// Ports `getPermissionModeOptionsForFlavor(flavor)`.
public func permissionModeOptions(forFlavor flavor: String?) -> [PermissionModeOption] {
    permissionModes(forFlavor: flavor).map(PermissionModeOption.init(mode:))
}

/// Ports `isPermissionModeAllowedForFlavor(mode, flavor)`.
public func isPermissionModeAllowed(_ mode: PermissionMode, forFlavor flavor: String?) -> Bool {
    permissionModes(forFlavor: flavor).contains(mode)
}

// MARK: - Codex collaboration modes

/// Ports `CODEX_COLLABORATION_MODES` + labels (`shared/src/modes.ts`).
public enum CodexCollaborationMode: String, Codable, CaseIterable, Sendable {
    case `default`
    case plan

    public var label: String {
        switch self {
        case .default: return "Default"
        case .plan: return "Plan"
        }
    }
}

// MARK: - Copilot agent modes

/// Ports `COPILOT_AGENT_MODES` + labels (`shared/src/copilotModes.ts`).
///
/// Decoding accepts the legacy `"fleet"` value and coerces it to
/// `.interactive`, mirroring `CopilotAgentModeSchema` (`shared/src/schemas.ts:9-12`).
public enum CopilotAgentMode: String, CaseIterable, Sendable {
    case interactive
    case plan
    case autopilot

    public var label: String {
        switch self {
        case .interactive: return "Interactive"
        case .plan: return "Plan"
        case .autopilot: return "Autopilot"
        }
    }

    /// Ports `normalizeCopilotAgentMode`: `"fleet"` and anything invalid
    /// coerce to `.interactive`.
    public static func normalize(_ value: String?) -> CopilotAgentMode {
        guard let value, value != "fleet" else { return .interactive }
        return CopilotAgentMode(rawValue: value) ?? .interactive
    }
}

extension CopilotAgentMode: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        if raw == "fleet" {
            self = .interactive
            return
        }
        guard let mode = CopilotAgentMode(rawValue: raw) else {
            throw DecodingError.dataCorrupted(DecodingError.Context(
                codingPath: decoder.codingPath,
                debugDescription: "Unknown CopilotAgentMode '\(raw)'"
            ))
        }
        self = mode
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
