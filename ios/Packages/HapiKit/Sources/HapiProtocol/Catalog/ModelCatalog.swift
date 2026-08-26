import Foundation

// Static model / effort catalogs — data port of `shared/src/models.ts`
// (`CLAUDE_MODEL_LABELS`) and `shared/src/effort.ts` (`CLAUDE_EFFORT_LABELS`),
// plus the composer option-list builders from
// `web/src/components/AssistantChat/claudeModelOptions.ts` /
// `claudeEffortOptions.ts` (mirroring the Android port's
// `core/protocol/.../catalog/Models.kt`). Codex-family model lists are NOT
// static — they come from `GET /api/sessions/:id/codex-models` per session.

/// `CLAUDE_MODEL_LABELS` / `CLAUDE_MODEL_PRESETS`.
public enum ClaudeModels {
    /// Preset ids in declaration (picker) order.
    public static let presets: [String] = [
        "sonnet",
        "sonnet[1m]",
        "opus",
        "opus[1m]",
        "fable",
        "fable[1m]",
    ]

    private static let labels: [String: String] = [
        "sonnet": "Sonnet",
        "sonnet[1m]": "Sonnet 1M",
        "opus": "Opus",
        "opus[1m]": "Opus 1M",
        "fable": "Fable",
        "fable[1m]": "Fable 1M",
    ]

    /// `getClaudeModelLabel`: trimmed lookup; unknown/blank → nil.
    public static func label(for model: String?) -> String? {
        let trimmed = model?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return labels[trimmed]
    }
}

/// `CLAUDE_EFFORT_LABELS` / `CLAUDE_EFFORT_LEVELS`.
public enum ClaudeEfforts {
    /// Levels in ascending order.
    public static let levels: [String] = ["low", "medium", "high", "xhigh", "max"]

    private static let labels: [String: String] = [
        "low": "Low",
        "medium": "Medium",
        "high": "High",
        "xhigh": "XHigh",
        "max": "Max",
    ]

    public static func label(for level: String) -> String? {
        labels[level]
    }
}

/// One picker row: `value == nil` means "clear back to the agent default"
/// (wire `model: null` / `effort: null`).
public struct CatalogOption: Equatable, Hashable, Sendable {
    public let value: String?
    public let label: String

    public init(value: String?, label: String) {
        self.value = value
        self.label = label
    }
}

/// Option-list builders for the session config sheet.
public enum ModelCatalog {
    /// `normalizeClaudeComposerModel`: `auto`/`default`/blank collapse to nil
    /// (the Default row).
    public static func normalizeClaudeModel(_ model: String?) -> String? {
        let trimmed = model?.trimmingCharacters(in: .whitespaces) ?? ""
        if trimmed.isEmpty || trimmed == "auto" || trimmed == "default" {
            return nil
        }
        return trimmed
    }

    /// `getClaudeComposerModelOptions`: Default first, then a synthetic row
    /// for a current model outside the preset list, then the presets.
    public static func claudeModelOptions(currentModel: String?) -> [CatalogOption] {
        let normalized = normalizeClaudeModel(currentModel)
        var options = [CatalogOption(value: nil, label: "Default")]
        if let normalized, !ClaudeModels.presets.contains(normalized) {
            options.append(CatalogOption(
                value: normalized,
                label: ClaudeModels.label(for: normalized) ?? normalized
            ))
        }
        for preset in ClaudeModels.presets {
            options.append(CatalogOption(
                value: preset,
                label: ClaudeModels.label(for: preset) ?? preset
            ))
        }
        return options
    }

    /// `normalizeClaudeComposerEffort`: lowercased; `auto`/`default`/blank → nil.
    public static func normalizeClaudeEffort(_ effort: String?) -> String? {
        let trimmed = effort?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        if trimmed.isEmpty || trimmed == "auto" || trimmed == "default" {
            return nil
        }
        return trimmed
    }

    /// `getClaudeComposerEffortOptions`: Auto first, synthetic current, then
    /// the levels.
    public static func claudeEffortOptions(currentEffort: String?) -> [CatalogOption] {
        let normalized = normalizeClaudeEffort(currentEffort)
        var options = [CatalogOption(value: nil, label: "Auto")]
        if let normalized, !ClaudeEfforts.levels.contains(normalized) {
            options.append(CatalogOption(
                value: normalized,
                label: ClaudeEfforts.label(for: normalized) ?? capitalizedFirst(normalized)
            ))
        }
        for level in ClaudeEfforts.levels {
            options.append(CatalogOption(
                value: level,
                label: ClaudeEfforts.label(for: level) ?? capitalizedFirst(level)
            ))
        }
        return options
    }

    /// Kotlin `replaceFirstChar { uppercase }` twin, shared with the codex
    /// effort rows built from wire level ids.
    public static func capitalizedFirst(_ value: String) -> String {
        guard let first = value.first else { return value }
        return first.uppercased() + value.dropFirst()
    }
}
