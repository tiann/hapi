import SwiftUI

/// Brand logo per agent flavor — port of `web/src/components/AgentFlavorIcon.tsx`
/// (brand SVGs via @lobehub/icons, the same source the web ships; assets live
/// in `Assets.xcassets/AgentIcons`).
///
/// Color variants (agy/claude/codex/gemini) carry `original` rendering intent
/// so the literal brand fills stay visible on light and dark — the reason the
/// web picked Color for them. Mono variants (cursor/grok/kimi/opencode/pi)
/// are template images and inherit the environment foreground style (the
/// web's currentColor); copilot mirrors the web's fixed GitHub-mark tint
/// (#24292F light / #E6EDF3 dark). Unknown flavors fall back to the web's
/// "Un" badge.
struct AgentFlavorIconView: View {
    let flavor: String?
    var size: CGFloat = 16

    @Environment(\.colorScheme) private var colorScheme

    /// Flavors with a bundled `AgentIcons/<flavor>` image set.
    private static let bundledFlavors: Set<String> = [
        "agy", "claude", "codex", "copilot", "cursor",
        "gemini", "grok", "kimi", "opencode", "pi",
    ]

    /// Asset name for a raw `metadata.flavor` value; nil when no icon ships.
    static func assetName(forFlavor flavor: String?) -> String? {
        guard let flavor else { return nil }
        let normalized = flavor.trimmingCharacters(in: .whitespaces).lowercased()
        return bundledFlavors.contains(normalized) ? normalized : nil
    }

    var body: some View {
        content
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var content: some View {
        if let name = Self.assetName(forFlavor: flavor) {
            let icon = Image(name)
                .resizable()
                .scaledToFit()
            if name == "copilot" {
                icon.foregroundStyle(colorScheme == .dark
                    ? Color(red: 230 / 255, green: 237 / 255, blue: 243 / 255)
                    : Color(red: 36 / 255, green: 41 / 255, blue: 47 / 255))
            } else {
                icon
            }
        } else {
            Text("Un")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 3))
        }
    }
}

#Preview("Agent icons") {
    AgentFlavorIconPreviewGrid()
}

#Preview("Agent icons · dark") {
    AgentFlavorIconPreviewGrid()
        .preferredColorScheme(.dark)
}

private struct AgentFlavorIconPreviewGrid: View {
    private let flavors: [String?] = [
        "agy", "claude", "codex", "copilot", "cursor",
        "gemini", "grok", "kimi", "opencode", "pi", "mystery",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(flavors, id: \.self) { flavor in
                HStack(spacing: 8) {
                    AgentFlavorIconView(flavor: flavor)
                    Text(flavor ?? "nil")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding()
    }
}
