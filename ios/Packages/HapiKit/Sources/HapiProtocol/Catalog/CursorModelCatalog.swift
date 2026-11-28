import Foundation

/// Cursor's picker sends exact catalog IDs. Parsed parameters are used only to find
/// a published neighbor, never to construct an ID for the CLI or ACP.
public struct CursorModelCatalog: Equatable, Sendable {
    public struct Field: Equatable, Sendable {
        public struct Choice: Equatable, Sendable {
            public let label: String
            /// Nil when the combination with the other current settings is unavailable.
            public let wire: String?
        }

        public let title: String
        public let choices: [Choice]
    }

    public let options: [AgentModelSummary]
    private let familiesWithCLI: Set<String>
    private let byFamily: [String: [AgentModelSummary]]
    public let families: [String]

    public init(response: AgentModelsResponse?) {
        var groups: [String: [AgentModelSummary]] = [:]
        var rows: [AgentModelSummary] = []
        var cliFamilies = Set<String>()
        var seen = Set<String>()
        func add(_ row: AgentModelSummary, family: String) {
            guard !family.isEmpty, seen.insert(row.modelId).inserted else { return }
            groups[family, default: []].append(row)
            rows.append(row)
        }
        if let response, response.success {
            for row in response.availableModels ?? [] {
                let id = row.modelId
                guard Self.selectionValue(id) != "auto", Self.selectionValue(id) != "default", AgentModelCatalog.isCursorCatalogModelId(id),
                      id == id.trimmingCharacters(in: .whitespacesAndNewlines) else { continue }
                if let bracket = id.firstIndex(of: "[") {
                    guard id.last == "]" else { continue }
                    add(row, family: String(id[..<bracket]))
                } else {
                    add(row, family: id)
                }
            }
            let acpFamilies = Set(groups.keys)
            for row in response.cliModelSkus ?? [] {
                let id = row.modelId
                guard Self.selectionValue(id) != "auto", Self.selectionValue(id) != "default", !id.contains("["), !id.contains("]"),
                      id == id.trimmingCharacters(in: .whitespacesAndNewlines) else { continue }
                let base = AgentModelCatalog.cursorCliSkuBaseId(id)
                let alias = base.hasPrefix("cursor-") ? String(base.dropFirst(7)) : "cursor-" + base
                let family = acpFamilies.contains(base) || !acpFamilies.contains(alias) ? base : alias
                cliFamilies.insert(family)
                add(row, family: family)
            }
        }
        familiesWithCLI = cliFamilies
        options = rows
        byFamily = groups
        families = groups.keys.sorted()
    }

    /// Keep a reported ACP default distinct from the explicit CLI Auto action.
    public static func selectionValue(_ selection: String?) -> String {
        let trimmed = selection?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch trimmed.lowercased() {
        case "", "auto": return "auto"
        case "default", "default[]": return "default"
        default: return trimmed
        }
    }

    public func contains(_ wire: String) -> Bool {
        wire == "auto" || options.contains { $0.modelId == wire }
    }

    public func family(for wire: String) -> String? {
        families.first { family in byFamily[family]?.contains { $0.modelId == wire } == true }
    }

    public func label(for family: String) -> String {
        let rows = byFamily[family] ?? []
        let base = rows.first { $0.modelId == family } ?? (rows.count == 1 ? rows.first : nil)
        guard let name = base?.name, !name.isEmpty else { return family }
        return name
    }

    public func defaultWire(for family: String) -> String? {
        byFamily[family]?.first?.modelId
    }

    private static let axes = [
        ("reasoning", "Reasoning effort"), ("reasoning_effort", "Reasoning effort"),
        ("effort", "Effort"), ("thinking", "Thinking"), ("context", "Context window"), ("fast", "Fast mode"),
    ]

    private static func parameters(_ id: String) -> [String: String] {
        if let bracket = id.firstIndex(of: "[") {
            var values: [String: String] = [:]
            for part in id[id.index(after: bracket)...].dropLast().split(separator: ",") {
                let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                let key = pair[0].trimmingCharacters(in: .whitespaces)
                values[key] = pair.count == 2 ? pair[1].trimmingCharacters(in: .whitespaces) : "true"
            }
            return values
        }
        // Only inspect the recognized suffix, so a model's name cannot imply an effort.
        let suffix = id.dropFirst(AgentModelCatalog.cursorCliSkuBaseId(id).count)
        let tokens = suffix.split(separator: "-")
        var values = ["fast": tokens.contains("fast") ? "true" : "false"]
        if suffix.contains("-extra-high") || tokens.contains("xhigh") {
            values["reasoning"] = "extra-high"
        } else {
            values["reasoning"] = tokens.first { ["none", "low", "medium", "high"].contains($0) }.map(String.init)
        }
        if tokens.contains("thinking") { values["thinking"] = "true" }
        return values
    }

    /// Independent fields are safe only if every published variant is reachable by
    /// changing one parameter at a time. Otherwise expose each complete variant.
    public func fields(for wire: String) -> [Field] {
        guard let family = family(for: wire), let all = byFamily[family], all.count > 1 else { return [] }
        let cli = all.filter { !$0.modelId.contains("[") }
        var variants = all
        var currentID = wire
        let usesSKUParameters = familiesWithCLI.contains(family)
        if usesSKUParameters, cli.count < all.count {
            // A SKU describes its parameters through suffixes. Mix representations
            // only if all ACP settings are represented by the advertised SKU menu.
            let acp = all.filter { $0.modelId.contains("[") }
            let contexts = Set(acp.map { Self.parameters($0.modelId)["context"] })
            guard cli.count > 1, contexts.count == 1 else { return Self.variantMenu(all) }
            for row in acp {
                guard let matched = Self.matchingSKU(for: row.modelId, cli: cli) else {
                    return Self.variantMenu(all)
                }
                if row.modelId == wire { currentID = matched }
            }
            variants = cli
        }
        guard let current = variants.firstIndex(where: { $0.modelId == currentID }) else { return [] }
        let params = variants.map { row in
            // A bare ACP base publishes no parameters. Only the CLI SKU naming
            // convention gives the absence of "-fast" an explicit false value.
            usesSKUParameters || row.modelId.contains("[") ? Self.parameters(row.modelId) : [:]
        }
        let keys = Set(params.flatMap(\.keys)).filter { key in params.contains { $0[key] != params[0][key] } }
        let axes = Self.axes.filter { keys.contains($0.0) }
        guard !axes.isEmpty, axes.count == keys.count, Set(params).count == variants.count else {
            return Self.variantMenu(all)
        }
        var visited: Set<Int> = [current]
        var pending = [current]
        while let index = pending.popLast() {
            for other in params.indices where !visited.contains(other) {
                if keys.filter({ params[index][$0] != params[other][$0] }).count == 1 {
                    visited.insert(other)
                    pending.append(other)
                }
            }
        }
        guard visited.count == variants.count else { return Self.variantMenu(all) }
        return axes.map { axis, title in
            var seen = Set<String?>()
            let choices: [Field.Choice] = params.compactMap { row in
                let value = row[axis]
                guard seen.insert(value).inserted else { return nil }
                let target = params.firstIndex { candidate in
                    candidate[axis] == value && keys.allSatisfy { $0 == axis || candidate[$0] == params[current][$0] }
                }
                let label: String
                switch (axis, value) {
                case ("thinking", "true"): label = "On"
                case ("thinking", "false"): label = "Off"
                case ("fast", "true"): label = "Fast"
                case ("fast", "false"): label = "Standard"
                default: label = value ?? "Default"
                }
                return .init(label: label, wire: target.map { $0 == current ? wire : variants[$0].modelId })
            }
            return Field(title: title, choices: choices)
        }
    }

    private static func matchingSKU(for wire: String, cli: [AgentModelSummary]) -> String? {
        let params = parameters(wire)
        let known = Set(axes.map { $0.0 })
        guard params.keys.allSatisfy(known.contains) else { return nil }
        let efforts = ["effort", "reasoning", "reasoning_effort"].compactMap { params[$0] }
        guard Set(efforts).count <= 1,
              !efforts.isEmpty || params["fast"] != nil || params["thinking"] != nil else { return nil }
        let effort = efforts.first == "xhigh" ? "extra-high" : efforts.first
        let matches = cli.filter { row in
            let hints = parameters(row.modelId)
            return hints["reasoning"] == effort
                && hints["fast"] == (params["fast"] ?? "false")
                && (hints["thinking"] ?? "false") == (params["thinking"] ?? "false")
        }
        return matches.count == 1 ? matches[0].modelId : nil
    }

    private static func variantMenu(_ variants: [AgentModelSummary]) -> [Field] {
        let choices = variants.map { variant -> Field.Choice in
            let id = variant.modelId
            let label: String
            if let opening = id.firstIndex(of: "[") {
                let suffix = String(id[id.index(after: opening)...].dropLast())
                label = suffix.isEmpty ? "Default" : suffix
            } else if let name = variant.name, !name.isEmpty,
                      variants.filter({ $0.name == name }).count == 1 {
                label = name
            } else {
                label = id
            }
            return .init(label: label, wire: id)
        }
        return [Field(title: "Variant", choices: choices)]
    }
}
