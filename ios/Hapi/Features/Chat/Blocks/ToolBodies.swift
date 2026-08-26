import HapiProtocol
import HapiUI
import SwiftUI

/// Expanded tool-card body: input rendering per tool kind + the result
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
/// - Ask/RequestUserInput → questions + options, read-only;
/// - anything else → pretty-printed JSON input, then the generic result.
struct ToolCallBody: View {
    let tool: ChatToolCall
    let basePath: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ToolInputSection(tool: tool, basePath: basePath)
            ToolResultSection(tool: tool)
        }
    }
}

// MARK: - Input

private let terminalToolNames: Set<String> = [
    "Bash", "CodexBash", "shell_command", "run_shell_command",
]

private struct ToolInputSection: View {
    let tool: ChatToolCall
    let basePath: String?

    var body: some View {
        let input = tool.input
        if terminalToolNames.contains(tool.name) {
            if let command = chatTerminalCommand(input) {
                CodeBlockView(language: "bash", code: command)
            }
        } else if tool.name == "Edit" {
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
        } else if tool.name == "MultiEdit" {
            multiEditBody(input)
        } else if tool.name == "Write" {
            if let content = chatInputString(input, ["content", "text"]) {
                CodeBlockView(
                    language: languageForPath(chatInputString(input, ["file_path", "path"])),
                    code: content
                )
            } else {
                GenericJSONInput(input: input)
            }
        } else if tool.name == "CodexDiff" {
            if let unified = chatInputString(input, ["unified_diff"]),
               let files = tryParseDiff(unified) {
                DiffTextView(files: files)
            } else {
                GenericJSONInput(input: input)
            }
        } else if tool.name == "TodoWrite" || tool.name == "update_plan" {
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
        } else if isAskUserQuestionToolName(tool.name) || isRequestUserInputToolName(tool.name) {
            QuestionsReadOnlyView(input: input)
        } else if tool.name == "Read" || tool.name == "NotebookRead" || tool.name == "LS" {
            // The title already carries the path; nothing else worth echoing.
            if let path = chatInputString(input, ["file_path", "path", "notebook_path"]) {
                SectionLabel(text: chatDisplayPath(path, basePath: basePath))
            }
        } else {
            GenericJSONInput(input: input)
        }
    }

    @ViewBuilder
    private func multiEditBody(_ input: JSONValue?) -> some View {
        let language = languageForPath(chatInputString(input, ["file_path", "path"]))
        if let edits = input?[chatKey: "edits"]?.chatArray {
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
            CodeBlockView(language: language, code: old.isEmpty ? String(localized: "(empty)") : old)
            SectionLabel(text: String(localized: "After"))
            CodeBlockView(language: language, code: new.isEmpty ? String(localized: "(empty)") : new)
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
            CodeBlockView(language: nil, code: text)
        case .some(let value):
            CodeBlockView(language: "json", code: chatPrettyJSON(value))
        }
    }
}

/// Questions + options, read-only (answer flows land in M3b).
private struct QuestionsReadOnlyView: View {
    let input: JSONValue?

    var body: some View {
        let questions = input?[chatKey: "questions"]?.chatArray ?? []
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(questions.enumerated()), id: \.offset) { _, entry in
                if let question = entry.chatObject {
                    VStack(alignment: .leading, spacing: 2) {
                        if let header = question["header"]?.chatString {
                            Text(header)
                                .font(.footnote.weight(.semibold))
                        }
                        if let text = question["question"]?.chatString {
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
                }
            }
        }
    }

    private func optionLabels(_ question: [String: JSONValue]) -> [String] {
        guard let options = question["options"]?.chatArray else { return [] }
        return options.compactMap { option in
            if let text = option.chatString { return text }
            if let object = option.chatObject {
                return object["label"]?.chatString ?? object["value"]?.chatString
            }
            return nil
        }
    }
}

// MARK: - Result

private let resultRenderCap = 20_000

private struct ToolResultSection: View {
    let tool: ChatToolCall

    var body: some View {
        if let result = tool.result, result != .null,
           let rendering = resultRendering(result) {
            VStack(alignment: .leading, spacing: 4) {
                SectionLabel(text: tool.state == .error
                    ? String(localized: "Result · error")
                    : String(localized: "Result"))
                switch rendering {
                case .diffs(let files):
                    DiffTextView(files: files)
                case .terminal(let text):
                    TerminalTextView(text: text, isError: tool.state == .error)
                case .json(let pretty):
                    CodeBlockView(language: "json", code: pretty)
                }
            }
        }
    }
}

/// How a tool result renders: parsed diff > extracted text > pretty JSON.
private enum ResultRendering {
    case diffs([DiffFile])
    case terminal(String)
    case json(String)
}

private func resultRendering(_ result: JSONValue) -> ResultRendering? {
    if let text = extractResultText(result) {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return nil
        }
        if let files = tryParseDiff(text) {
            return .diffs(files)
        }
        return .terminal(String(text.prefix(resultRenderCap)))
    }
    return .json(String(chatPrettyJSON(result).prefix(resultRenderCap)))
}

/// Text of the common result shapes: plain string; `{stdout, stderr}`;
/// Claude-style `[{type: "text", text}]` arrays (or the same under
/// `content`). Nil → not text-like, render as JSON.
func extractResultText(_ result: JSONValue) -> String? {
    switch result {
    case .string(let text):
        return text
    case .array(let entries):
        var texts: [String] = []
        for entry in entries {
            guard let object = entry.chatObject,
                  object["type"]?.chatString == "text",
                  let text = object["text"]?.chatString else {
                return nil
            }
            texts.append(text)
        }
        return texts.joined(separator: "\n")
    case .object(let object):
        let stdout = object["stdout"]?.chatString
        let stderr = object["stderr"]?.chatString
        if stdout != nil || stderr != nil {
            var parts: [String] = []
            if let out = stdout?.trimmedTrailing(), !out.isEmpty {
                parts.append(out)
            }
            if let err = stderr?.trimmedTrailing(), !err.isEmpty {
                parts.append("stderr:\n\(err)")
            }
            return parts.joined(separator: "\n\n")
        }
        if let content = object["content"] {
            if case .array = content {
                return extractResultText(content)
            }
            if let text = content.chatString {
                return text
            }
        }
        return nil
    default:
        return nil
    }
}

extension String {
    fileprivate func trimmedTrailing() -> String {
        var value = Substring(self)
        while let last = value.last, last.isWhitespace || last.isNewline {
            value = value.dropLast()
        }
        return String(value)
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
    "xml": "xml", "html": "html", "css": "css", "md": "markdown", "sql": "sql",
]

func languageForPath(_ path: String?) -> String? {
    guard let path, let dot = path.lastIndex(of: "."), dot != path.startIndex else { return nil }
    let ext = path[path.index(after: dot)...].lowercased()
    guard !ext.isEmpty, !ext.contains("/") else { return nil }
    return extensionLanguages[ext]
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
