import Foundation

// Static model / effort catalogs — data port of `shared/src/models.ts`
// (`CLAUDE_MODEL_LABELS`) and `shared/src/effort.ts` (`CLAUDE_EFFORT_LABELS`),
// plus the composer option-list builders from
// `web/src/components/AssistantChat/claudeModelOptions.ts` /
// `claudeEffortOptions.ts` (mirroring the Android port's
// `core/protocol/.../catalog/Models.kt`). Codex-family model lists are NOT
// static — they come from `GET /api/sessions/:id/codex-models` per session.

/// `CLAUDE_MODEL_LABELS` (recognition) / `CLAUDE_MODEL_FALLBACK_OPTIONS` (offer).
public enum ClaudeModels {
    /// `CLAUDE_MODEL_FALLBACK_OPTIONS`: what the picker offers when the live
    /// catalog is unavailable -- one row per family, in catalog order. The
    /// `[1m]` ids are absent here on purpose: they are the same models as their
    /// bare counterparts, so they survive only in `labels` below, which keeps
    /// resolving them for sessions created before they were dropped.
    ///
    /// Haiku is absent for a different reason: it is the first Claude model
    /// that supports no effort at all, and these pickers post model and effort
    /// separately against a static effort list, so offering it here would let a
    /// native session sit on Haiku with `high` pinned. `labels` still resolves
    /// it, so a session already on Haiku renders correctly. Add it once the
    /// native effort offers are model-aware.
    public static let fallbackPresets: [String] = [
        "opus",
        "fable",
        "sonnet",
    ]

    /// Families the catalog reports as supporting no `--effort` at all, ported
    /// from `CLAUDE_MODEL_FALLBACK_OPTIONS`' `supportedEffortLevels` in
    /// `shared/src/models.ts`. Anything absent here is treated as supporting
    /// the full level set, which is also what an unknown or Default selection
    /// gets: nothing has said otherwise.
    private static let effortlessFamilies: Set<String> = ["haiku"]

    /// Whether `--effort` means anything for this model, in whatever form the
    /// identifier arrives: a preset, a legacy `[1m]` alias, or a resolved SDK id
    /// such as `claude-haiku-4-5-20251001`. Mirrors `resolveClaudeModelFamily`
    /// in `shared/src/models.ts` -- resolved ids are `claude-<family>-...`, so
    /// the family is read structurally rather than from an id-by-id table.
    public static func supportsEffort(_ model: String?) -> Bool {
        !effortlessFamilies.contains(family(of: model) ?? "")
    }

    /// Family behind an identifier; nil for the Default sentinel and for
    /// anything neither a known alias nor a `claude-` id.
    public static func family(of model: String?) -> String? {
        let trimmed = model?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        if trimmed.isEmpty || trimmed == "auto" || trimmed == "default" { return nil }
        let bare = trimmed.hasSuffix("[1m]") ? String(trimmed.dropLast(4)) : trimmed
        if labels[bare] != nil { return bare }
        guard bare.contains("claude") else { return nil }
        // Scan for a segment naming a known family rather than taking a fixed
        // position: ids from before Claude 4 are `claude-<generation>-<family>-...`
        // so a positional read returns the generation and conflates every model
        // of it. Scanning also tolerates a vendor prefix such as `us.anthropic.`.
        let families = Set(labels.keys.map { key in
            key.hasSuffix("[1m]") ? String(key.dropLast(4)) : key
        })
        return bare
            .split(whereSeparator: { $0 == "-" || $0 == "." })
            .map(String.init)
            .first(where: { families.contains($0) })
    }

    /// `CLAUDE_MODEL_LABELS`: recognition aliases, wider than the offer list.
    private static let labels: [String: String] = [
        "sonnet": "Sonnet",
        "sonnet[1m]": "Sonnet 1M",
        "opus": "Opus",
        "opus[1m]": "Opus 1M",
        "fable": "Fable",
        "fable[1m]": "Fable 1M",
        "haiku": "Haiku",
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
        if let normalized, !ClaudeModels.fallbackPresets.contains(normalized) {
            options.append(CatalogOption(
                value: normalized,
                label: ClaudeModels.label(for: normalized) ?? normalized
            ))
        }
        for preset in ClaudeModels.fallbackPresets {
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
    public static func claudeEffortOptions(currentEffort: String?, model: String? = nil) -> [CatalogOption] {
        // A model that supports no effort offers Auto only, the same shape the
        // web composer renders for it. Without this a session switched to Haiku
        // elsewhere could be pinned back to `high` from here.
        guard ClaudeModels.supportsEffort(model) else {
            return [CatalogOption(value: nil, label: "Auto")]
        }
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
