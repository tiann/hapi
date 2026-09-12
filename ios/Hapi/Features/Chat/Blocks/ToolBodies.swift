import HapiProtocol
import HapiUI
import SwiftUI

/// Read-only inspector body: input rendering per tool kind + the result
/// section (the read-only slice of `web/src/components/ToolCard/views/`,
/// via the Android `ToolBodies` port):
///
/// - terminal family → command as a bash code block, stdout/stderr
///   terminal-styled;
/// - `Edit`/`MultiEdit` structured edits → before/after code blocks;
/// - `Write` → the written content as a code block;
/// - `CodexDiff` (and any input/result that parses as a unified diff) →
///   `DiffTextView`;
/// - `TodoWrite`/`update_plan` → checklist rows;
/// - Ask/RequestUserInput → questions + selected answers, read-only;
/// - anything else → pretty-printed JSON input, then the generic result.
struct ToolCallBody: View {
    let tool: ChatToolCall
    let basePath: String?
    @State private var sourceExpanded = false

    var body: some View {
        let questionTool = isQuestionDetailsTool(tool.name)
        let answers = questionTool ? tool.permission?.answers : nil
        VStack(alignment: .leading, spacing: 12) {
            if questionTool {
                QuestionToolBody(tool: tool)
            } else {
                SectionLabel(text: String(localized: "Input"))
                ToolInputSection(tool: tool, basePath: basePath)
                ToolResultSection(tool: tool)
            }
            if tool.input != nil || tool.result != nil || answers != nil {
                DisclosureGroup("Source", isExpanded: $sourceExpanded) {
                    if sourceExpanded {
                        if let input = tool.input {
                            SectionLabel(text: String(localized: "Input"))
                            GenericJSONInput(input: input)
                        }
                        if let result = tool.result {
                            SectionLabel(text: String(localized: "Result"))
                            GenericJSONInput(input: result)
                        }
                        if let answers {
                            SectionLabel(text: String(localized: "Answers"))
                            GenericJSONInput(input: answers)
                        }
                    }
                }
            }
        }
    }
}

private struct QuestionToolBody: View {
    let tool: ChatToolCall
    @State private var details: QuestionToolDetails?

    var body: some View {
        Group {
            if let details {
                SectionLabel(text: details.hasAnswers
                    ? String(localized: "Questions & Answers") : String(localized: "Input"))
                if details.questions.isEmpty {
                    GenericJSONInput(input: tool.input)
                } else {
                    QuestionDetailsView(questions: details.questions)
                }
                if details.showResult { ToolResultSection(tool: tool) }
            } else {
                ProgressView()
            }
        }
        .task(id: tool) {
            let tool = tool
            let next = await Task.detached(priority: .userInitiated) { questionToolDetails(tool) }.value
            guard !Task.isCancelled else { return }
            details = next
        }
    }
}

// MARK: - Input

private struct ToolInputSection: View {
    let tool: ChatToolCall
    let basePath: String?

    var body: some View {
        let input = tool.input
        let name = toolPresentationName(tool.name)
        if terminalToolNames.contains(name) {
            if let command = chatTerminalCommand(input) {
                ToolTextContent(language: "bash", code: command)
            } else {
                GenericJSONInput(input: input)
            }
        } else if name == "exec", let source = toolSourceInput(input, keys: ["code", "script"]) {
            ToolTextContent(language: "javascript", code: source)
        } else if name == "CodexPatch", let patch = toolSourceInput(input, keys: ["patch", "input", "command"]) {
            ToolTextContent(language: "diff", code: patch)
        } else if name == "Edit" {
            if let old = chatInputString(input, ["old_string"]),
               let new = chatInputString(input, ["new_string"]) {
                BeforeAfterView(
                    old: old,
                    new: new,
                    language: languageForPath(chatInputString(input, ["file_path", "path"]))
                )
            } else {
                GenericJSONInput(input: input)
            }
        } else if name == "MultiEdit" {
            multiEditBody(input)
        } else if name == "Write" {
            if let content = chatInputString(input, ["content", "text"]) {
                ToolTextContent(
                    language: languageForPath(chatInputString(input, ["file_path", "path"])),
                    code: content
                )
            } else {
                GenericJSONInput(input: input)
            }
        } else if name == "CodexDiff" {
            if let unified = chatInputString(input, ["unified_diff"]) {
                ToolDiffContent(text: unified)
            } else {
                GenericJSONInput(input: input)
            }
        } else if name == "TodoWrite" || name == "update_plan" {
            let items = checklistItems(input)
            if !items.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                        Text("\(item.glyph) \(item.text)")
                            .font(.footnote)
                    }
                }
            } else {
                GenericJSONInput(input: input)
            }
        } else if name == "request_user_input_async" {
            QuestionsReadOnlyView(input: input)
        } else {
            GenericJSONInput(input: input)
        }
    }

    @ViewBuilder
    private func multiEditBody(_ input: JSONValue?) -> some View {
        let language = languageForPath(chatInputString(input, ["file_path", "path"]))
        if let edits = input?[chatKey: "edits"]?.chatArray, !edits.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(edits.enumerated()), id: \.offset) { index, edit in
                    if let old = chatInputString(edit, ["old_string"]),
                       let new = chatInputString(edit, ["new_string"]) {
                        VStack(alignment: .leading, spacing: 6) {
                            if edits.count > 1 {
                                SectionLabel(text: String(
                                    format: String(localized: "Edit %lld/%lld"),
                                    Int64(index + 1),
                                    Int64(edits.count)
                                ))
                            }
                            BeforeAfterView(old: old, new: new, language: language)
                        }
                    } else {
                        GenericJSONInput(input: edit)
                    }
                }
            }
        } else {
            GenericJSONInput(input: input)
        }
    }
}

private struct BeforeAfterView: View {
    let old: String
    let new: String
    let language: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(text: String(localized: "Before"))
            ToolTextContent(language: language, code: old.isEmpty ? String(localized: "(empty)") : old)
            SectionLabel(text: String(localized: "After"))
            ToolTextContent(language: language, code: new.isEmpty ? String(localized: "(empty)") : new)
        }
    }
}

private struct GenericJSONInput: View {
    let input: JSONValue?

    var body: some View {
        switch input {
        case nil, .some(.null):
            EmptyView()
        case .some(.string(let text)):
            ToolTextContent(language: nil, code: text)
        case .some(let value):
            ToolJSONContent(value: value)
        }
    }
}

private struct ToolJSONContent: View {
    let value: JSONValue
    @State private var text: String?
    var body: some View {
        Group {
            if let text { ToolTextContent(language: "json", code: text) }
            else { ProgressView() }
        }
        .task(id: value) {
            let value = value
            let rendered = await Task.detached(priority: .userInitiated) { chatPrettyJSON(value) }.value
            guard !Task.isCancelled else { return }
            text = rendered
        }
    }
}

/// Legacy asynchronous prompts have a different input shape and no answer map.
private struct QuestionsReadOnlyView: View {
    let input: JSONValue?

    var body: some View {
        let questions = input?[chatKey: "questions"]?.chatArray ?? []
        if questions.isEmpty {
            GenericJSONInput(input: input)
        }
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(questions.enumerated()), id: \.offset) { _, entry in
                if let question = entry.chatObject,
                   chatInputString(entry, ["question", "title"]) != nil {
                    VStack(alignment: .leading, spacing: 2) {
                        if let header = question["header"]?.chatString {
                            Text(header)
                                .font(.footnote.weight(.semibold))
                        }
                        if let text = question["question"]?.chatString ?? question["title"]?.chatString {
                            Text(text)
                                .font(.subheadline)
                        }
                        ForEach(Array(optionLabels(question).enumerated()), id: \.offset) { _, label in
                            Text("◦ \(label)")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .padding(.leading, 8)
                                .padding(.top, 2)
                        }
                    }
                } else {
                    GenericJSONInput(input: entry)
                }
            }
        }
    }

    private func optionLabels(_ question: [String: JSONValue]) -> [String] {
        guard let options = question["options"]?.chatArray else { return [] }
        return options.map(toolQuestionOptionText)
    }
}

// MARK: - Result

private struct ToolResultSection: View {
    let tool: ChatToolCall
    @State private var rendering: ResultRendering?
    @State private var prepared = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: tool.state == .error
                ? String(localized: "Result · error") : String(localized: "Result"))
            let metadata = toolResultMetadata(tool.result)
            if !metadata.isEmpty {
                Text(metadata.joined(separator: " · "))
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if let rendering {
                switch rendering {
                case .diffs(let files): DiffTextView(files: files)
                case .terminal(let text): ToolTextContent(language: nil, code: text, terminal: true, isError: tool.state == .error)
                case .json(let text): ToolTextContent(language: "json", code: text)
                case .code(let text, let language): ToolTextContent(language: language, code: text)
                case .markdown(let text): CachedMarkdownView(markdown: text)
                }
            } else if !prepared {
                ProgressView()
            } else {
                Text(tool.state == .running || tool.state == .pending
                     ? String(localized: "Waiting for output…") : String(localized: "No output"))
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .task(id: tool) {
            let tool = tool
            let next = await Task.detached(priority: .userInitiated) { resultRendering(tool) }.value
            guard !Task.isCancelled else { return }
            rendering = next
            prepared = true
        }
    }
}

enum ResultRendering: Sendable {
    case diffs([DiffFile])
    case terminal(String)
    case json(String)
    case code(String, String?)
    case markdown(String)
}

func resultRendering(_ tool: ChatToolCall) -> ResultRendering? {
    guard let result = tool.result, result != .null else { return nil }
    if let text = extractResultText(result) {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        // Huge diffs use paged source, rather than eagerly making a SwiftUI
        // row for every line. The complete received content stays accessible.
        switch toolResultStyle(tool) {
        case .code(let language): return .code(text, language)
        case .markdown:
            // Do not split markdown mid-fence; large documents use paged source.
            return text.count <= toolTextPageSize ? .markdown(text) : .code(text, "markdown")
        case .terminal:
            if tool.state != .error, text.count <= toolTextPageSize, let files = tryParseDiff(text) { return .diffs(files) }
            return .terminal(text)
        }
    }
    return .json(chatPrettyJSON(result))
}

private struct ToolDiffContent: View {
    let text: String
    @State private var files: [DiffFile]?
    var body: some View {
        Group {
            if let files { DiffTextView(files: files) }
            else { ToolTextContent(language: "diff", code: text) }
        }
        .task(id: text) {
            let text = text
            let parsed = await Task.detached(priority: .userInitiated) {
                text.count <= toolTextPageSize ? tryParseDiff(text) : nil
            }.value
            guard !Task.isCancelled else { return }
            files = parsed
        }
    }
}

// MARK: - Shared helpers

/// Parse `text` as a unified diff when it plausibly is one (the same marker
/// heuristics as the Android port, over the HapiUI parser).
func tryParseDiff(_ text: String) -> [DiffFile]? {
    guard hasDiffMarkers(text) else { return nil }
    let files = UnifiedDiffParser.parse(text)
    guard !files.isEmpty, files.contains(where: { !$0.hunks.isEmpty || $0.isBinary }) else {
        return nil
    }
    return files
}

private func hasDiffMarkers(_ text: String) -> Bool {
    var sawHunk = false
    var sawHeader = false
    for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
        if !sawHunk, rawLine.hasPrefix("@@ -"), rawLine.dropFirst(4).first?.isNumber == true {
            sawHunk = true
        }
        if !sawHeader, rawLine.hasPrefix("diff --git ") || rawLine.hasPrefix("--- ") {
            sawHeader = true
        }
        if sawHunk && sawHeader {
            return true
        }
    }
    return false
}

private let extensionLanguages: [String: String] = [
    "kt": "kotlin", "kts": "kotlin", "java": "java", "ts": "typescript",
    "tsx": "typescript", "js": "javascript", "jsx": "javascript", "py": "python",
    "rb": "ruby", "go": "go", "rs": "rust", "swift": "swift", "c": "c",
    "h": "c", "cpp": "cpp", "cc": "cpp", "cs": "csharp", "sh": "shell",
    "bash": "shell", "json": "json", "yml": "yaml", "yaml": "yaml",
    "cjs": "javascript", "mjs": "javascript", "mts": "typescript", "cts": "typescript",
    "toml": "toml", "zsh": "shell", "diff": "diff", "patch": "diff",
    "xml": "xml", "html": "html", "css": "css", "md": "markdown", "sql": "sql",
]

func languageForPath(_ path: String?) -> String? {
    guard let name = path?.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last?.lowercased() else { return nil }
    if name == "dockerfile" { return "dockerfile" }
    if name == "makefile" { return "makefile" }
    guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return nil }
    return extensionLanguages[String(name[name.index(after: dot)...])]
}

/// `(glyph, text)` rows for TodoWrite `todos` / update_plan `plan` items.
func checklistItems(_ input: JSONValue?) -> [(glyph: String, text: String)] {
    guard let object = input?.chatObject else { return [] }
    guard let array = (object["todos"] ?? object["plan"])?.chatArray else { return [] }
    return array.compactMap { entry in
        guard let item = entry.chatObject else { return nil }
        guard let content = item["content"]?.chatString ?? item["step"]?.chatString else {
            return nil
        }
        let glyph: String
        switch item["status"]?.chatString {
        case "completed", "complete", "done": glyph = "☑"
        case "in_progress": glyph = "◐"
        default: glyph = "☐"
        }
        return (glyph: glyph, text: content)
    }
}

struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(.secondary)
    }
}
