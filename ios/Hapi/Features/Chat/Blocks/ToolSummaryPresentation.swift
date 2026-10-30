import Foundation
import HapiProtocol
import HapiUI
import SwiftUI

extension HapiTypography {
    // Use the same resolved metrics as markdown, not the UIKit hosting cell's
    // system font defaults. Baselines remain subheadline (15) / footnote (13).
    var toolTitleFont: Font { .system(size: 15 * bodyScale, weight: boldText ? .semibold : .medium) }
    var toolSubtitleFont: Font { .system(size: 13 * codeScale, weight: boldText ? .semibold : .regular) }
    var toolIconWidth: CGFloat { 18 * codeScale }
    var usesStackedToolLayout: Bool { bodySize > 24 }
}

/// Conversation-only labels. Keep the inspector's original tool/input presentation
/// intact: a useful activity summary is not a replacement for the recorded call.
func toolSummaryPresentation(_ tool: ChatToolCall, basePath: String?) -> ToolCardPresentation {
    var canonical = tool
    canonical.name = toolPresentationName(tool.name)
    var presentation = toolCardPresentation(canonical, basePath: basePath)
    let input = tool.input

    func file(_ action: String, keys: [String], icon: String? = nil) -> ToolCardPresentation {
        let target = chatInputString(input, keys).map(summaryBasename)
        return ToolCardPresentation(
            icon: icon ?? presentation.icon,
            title: target.map { "\(action) · \($0)" } ?? action,
            subtitle: nil
        )
    }

    switch canonical.name {
    case "Read", "NotebookRead":
        return file(String(localized: "Read file"), keys: ["file_path", "path", "file", "notebook_path"])
    case "Edit", "MultiEdit", "NotebookEdit":
        return file(String(localized: "Edit file"), keys: ["file_path", "path", "notebook_path"])
    case "Write":
        return file(String(localized: "Write file"), keys: ["file_path", "path"])
    case "LS":
        return file(String(localized: "List files"), keys: ["path"])
    case "CodexBash":
        if let parsed = input?[chatKey: "parsed_cmd"]?.chatArray, parsed.count == 1,
           parsed[0][chatKey: "type"]?.chatString == "read",
           let path = parsed[0][chatKey: "name"]?.chatString {
            return ToolCardPresentation(icon: "eye", title: "\(String(localized: "Read file")) · \(summaryBasename(path))", subtitle: nil)
        }
    case "view_image":
        return file(String(localized: "View image"), keys: ["path", "file_path", "image_path"], icon: "photo")
    case "mcp__hapi__display_image", "hapi__display_image", "hapi_display_image":
        return file(String(localized: "Show image"), keys: ["path"], icon: "photo")
    case "mcp__hapi__display_video", "hapi__display_video", "hapi_display_video":
        return file(String(localized: "Show video"), keys: ["path"], icon: "film")
    case "mcp__hapi__display_media", "hapi__display_media", "hapi_display_media":
        return file(String(localized: "Share file"), keys: ["path"], icon: "doc")
    case "exec":
        return ToolCardPresentation(icon: "curlybraces", title: tool.description ?? String(localized: "Run script"), subtitle: nil)
    case "wait":
        return ToolCardPresentation(icon: "hourglass", title: String(localized: "Wait for result"), subtitle: nil)
    case "write_stdin":
        return ToolCardPresentation(icon: "terminal", title: String(localized: "Continue command"), subtitle: nil)
    default:
        break
    }
    if let subtitle = presentation.subtitle {
        // Don't waste the preview on indentation, line breaks, or a long directory.
        if let path = chatInputString(input, ["file_path", "path", "filePath", "file"]), subtitle == chatTruncate(path, 80) {
            presentation.subtitle = summaryBasename(path)
        } else {
            presentation.subtitle = subtitle.prefix(240).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        }
        if presentation.subtitle == presentation.title { presentation.subtitle = nil }
    }
    return presentation
}

private func summaryBasename(_ path: String) -> String {
    path.split(separator: "/").last.map(String.init) ?? path
}
