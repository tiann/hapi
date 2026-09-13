import HapiUI
import SwiftUI

let toolTextPageSize = 20_000

/// Character boundaries preserve Unicode exactly; concatenating pages is the
/// original payload, including newlines and trailing whitespace.
func toolTextPages(_ text: String) -> [String] {
    var pages: [String] = []
    var start = text.startIndex
    while start < text.endIndex {
        let end = text.index(start, offsetBy: toolTextPageSize, limitedBy: text.endIndex) ?? text.endIndex
        pages.append(String(text[start..<end]))
        start = end
    }
    return pages
}

struct ToolTextContent: View {
    let language: String?
    let code: String
    var terminal = false
    var isError = false

    var body: some View {
        if code.count <= toolTextPageSize {
            if terminal {
                TerminalTextView(text: code, isError: isError)
            } else {
                CodeBlockView(language: language, code: code)
            }
        } else {
            PagedToolText(language: language, code: code, terminal: terminal, isError: isError)
        }
    }
}

private struct PagedToolText: View {
    let language: String?
    let code: String
    let terminal: Bool
    let isError: Bool
    @State private var pages: [String] = []
    @State private var visiblePages = 1
    @Environment(\.hapiPasteboard) private var pasteboard

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 8) {
            Button("Copy full content", systemImage: "doc.on.doc") { pasteboard.copy(code) }
                .frame(minHeight: 44)
            if pages.isEmpty { ProgressView() }
            ForEach(Array(pages.prefix(visiblePages).enumerated()), id: \.offset) { _, page in
                if terminal {
                    TerminalTextView(text: page, isError: isError)
                } else {
                    CodeBlockView(language: language, code: page)
                }
            }
            if visiblePages < pages.count {
                Text(String(format: String(localized: "Showing %lld of %lld parts"),
                            Int64(visiblePages), Int64(pages.count)))
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Load more content") { visiblePages += 1 }
                    .frame(minHeight: 44)
            }
        }
        .task(id: code) {
            let code = code
            let next = await Task.detached(priority: .userInitiated) { toolTextPages(code) }.value
            guard !Task.isCancelled else { return }
            pages = next
        }
    }
}
