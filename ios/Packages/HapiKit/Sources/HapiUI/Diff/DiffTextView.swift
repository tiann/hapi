import SwiftUI

/// Unified-diff renderer: per-line rows with a two-column line-number gutter,
/// `+`/`-` colored backgrounds, hunk headers, file headers with +/- stats,
/// horizontal scrolling, and an optional compact mode that shows the first N
/// rows with an expand control.
public struct DiffTextView: View {
    public let files: [DiffFile]
    public let compact: Bool
    public let compactLineLimit: Int

    @State private var expanded = false
    @Environment(\.hapiTheme) private var theme

    public init(files: [DiffFile], compact: Bool = false, compactLineLimit: Int = 12) {
        self.files = files
        self.compact = compact
        self.compactLineLimit = compactLineLimit
    }

    public init(file: DiffFile, compact: Bool = false, compactLineLimit: Int = 12) {
        self.init(files: [file], compact: compact, compactLineLimit: compactLineLimit)
    }

    /// Parses `unifiedDiff` and renders every file it contains.
    public init(unifiedDiff: String, compact: Bool = false, compactLineLimit: Int = 12) {
        self.init(
            files: UnifiedDiffParser.parse(unifiedDiff),
            compact: compact,
            compactLineLimit: compactLineLimit
        )
    }

    // MARK: Rows

    private enum RowKind {
        case fileHeader(DiffFile)
        case hunkHeader(String)
        case line(DiffLine)
        case binaryNote
    }

    private struct Row: Identifiable {
        let id: Int
        let kind: RowKind
    }

    private var allRows: [Row] {
        var rows: [Row] = []
        var id = 0
        func append(_ kind: RowKind) {
            rows.append(Row(id: id, kind: kind))
            id += 1
        }
        for file in files {
            append(.fileHeader(file))
            if file.isBinary {
                append(.binaryNote)
            }
            for hunk in file.hunks {
                append(.hunkHeader(hunk.header))
                for line in hunk.lines {
                    append(.line(line))
                }
            }
        }
        return rows
    }

    /// Width (in characters) of one gutter column.
    private var gutterDigits: Int {
        var maxNumber = 1
        for file in files {
            for hunk in file.hunks {
                for line in hunk.lines {
                    if let old = line.oldNumber { maxNumber = max(maxNumber, old) }
                    if let new = line.newNumber { maxNumber = max(maxNumber, new) }
                }
            }
        }
        return max(2, String(maxNumber).count)
    }

    public var body: some View {
        let rows = allRows
        let limited = compact && !expanded && rows.count > compactLineLimit
        let visible = limited ? Array(rows.prefix(compactLineLimit)) : rows
        let digits = gutterDigits

        VStack(alignment: .leading, spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(visible) { row in
                        rowView(row, gutterDigits: digits)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            if limited {
                Button {
                    expanded = true
                } label: {
                    Text("Show all \(rows.count) lines")
                        .font(theme.captionFont)
                        .foregroundStyle(theme.link)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
            }
        }
        .background(theme.codeBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private func rowView(_ row: Row, gutterDigits: Int) -> some View {
        switch row.kind {
        case .fileHeader(let file):
            HStack(spacing: 8) {
                Text(file.displayPath)
                    .font(.system(size: theme.captionSize, design: .monospaced))
                    .foregroundStyle(theme.textSecondary)
                    .lineLimit(1)
                if file.kind == .renamed {
                    badge("renamed", color: theme.warning)
                }
                if file.isBinary {
                    badge("binary", color: theme.textHint)
                } else {
                    badge("+\(file.additions)", color: theme.success)
                    badge("−\(file.deletions)", color: theme.danger)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(theme.codeHeaderBackground)
        case .hunkHeader(let header):
            Text(header)
                .font(theme.codeFont)
                .foregroundStyle(theme.textSecondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 3)
                .background(theme.hunkHeaderBackground)
        case .binaryNote:
            Text("Binary file not shown")
                .font(theme.captionFont)
                .foregroundStyle(theme.textHint)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
        case .line(let line):
            lineRow(line, gutterDigits: gutterDigits)
        }
    }

    private func lineRow(_ line: DiffLine, gutterDigits: Int) -> some View {
        let (background, foreground, prefix): (Color?, Color, String) = {
            switch line.kind {
            case .addition:
                return (theme.diffAddedBackground, theme.diffAddedForeground, "+")
            case .deletion:
                return (theme.diffRemovedBackground, theme.diffRemovedForeground, "-")
            case .context:
                return (nil, theme.textPrimary, " ")
            case .noNewlineMarker:
                return (nil, theme.textHint, " ")
            }
        }()

        var text = AttributedString(
            paddedNumber(line.oldNumber, width: gutterDigits)
                + " "
                + paddedNumber(line.newNumber, width: gutterDigits)
                + "  "
        )
        text.foregroundColor = theme.textHint
        var content = AttributedString(prefix + " " + line.text)
        content.foregroundColor = foreground
        text.append(content)

        return Text(text)
            .font(theme.codeFont)
            .padding(.horizontal, 12)
            .padding(.vertical, 1)
            .background(background ?? Color.clear)
    }

    private func paddedNumber(_ number: Int?, width: Int) -> String {
        let digits = number.map(String.init) ?? ""
        if digits.count >= width { return digits }
        return String(repeating: " ", count: width - digits.count) + digits
    }

    private func badge(_ label: String, color: Color) -> some View {
        Text(label)
            .font(.system(size: theme.captionSize - 1, weight: .medium, design: .monospaced))
            .foregroundStyle(color)
    }
}
