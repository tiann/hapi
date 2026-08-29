import HapiProtocol
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Port of web `DisplayLinksCard`: tappable http(s) rows plus exact-copy strings.
struct DisplayLinksBlockView: View {
    let block: DisplayLinksBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(heading)
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(Array(block.urls.enumerated()), id: \.offset) { _, url in
                if let link = URL(string: url.href),
                   let scheme = link.scheme?.lowercased(),
                   scheme == "http" || scheme == "https" {
                    Link(destination: link) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(url.title?.isEmpty == false ? url.title! : url.href)
                                .font(.body.weight(.medium))
                                .foregroundStyle(.link)
                            if let title = url.title, !title.isEmpty {
                                Text(url.href)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                } else {
                    Text(url.title?.isEmpty == false ? url.title! : url.href)
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(Array(block.texts.enumerated()), id: \.offset) { _, text in
                Button {
                    copyExactValue(text.value)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        if let title = text.title, !title.isEmpty {
                            Text(title)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Text(text.value)
                            .font(.body.monospaced())
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.leading)
                        Text("Tap to copy")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.secondary.opacity(0.25))
        )
    }

    private var heading: String {
        let hasUrls = !block.urls.isEmpty
        let hasTexts = !block.texts.isEmpty
        if hasUrls && hasTexts { return "Links & copy" }
        if hasTexts { return "Copy" }
        return "Links"
    }

    /// Local-only + short TTL — exact-copy cards may hold secrets/tokens.
    private func copyExactValue(_ value: String) {
        UIPasteboard.general.setItems(
            [[UTType.utf8PlainText.identifier: value]],
            options: [
                .localOnly: true,
                .expirationDate: Date().addingTimeInterval(120),
            ]
        )
    }
}
