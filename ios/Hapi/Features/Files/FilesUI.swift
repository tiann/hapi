import Foundation
import HapiClient
import HapiProtocol
import SwiftUI

// Shared bits of the files feature UI (A-M4a): the viewer route value,
// metadata formatting (web `file-metadata.ts`), and the status-badge
// letters/palette (web `StatusBadge` + `--app-git-*-color` vars) — in
// lockstep with the Android `FilesUi.kt`.

/// Push value for the single-file viewer. `staged` picks the diff side,
/// `mode` the initial mode (nil = diff with auto-fallback), `line` a chat
/// citation hint.
struct FileViewerRoute: Hashable {
    var sessionId: String
    var path: String
    var staged: Bool? = nil
    var mode: FileViewerModel.Mode? = nil
    var line: Int? = nil
}

/// `1.2 KB` / `640 B`; nil when size is unknown (web `formatFileSize`).
func formatFileSize(_ bytes: Int?) -> String? {
    guard let bytes, bytes >= 0 else { return nil }
    if bytes < 1024 { return "\(bytes) B" }
    let units = ["KB", "MB", "GB", "TB"]
    var value = Double(bytes)
    var unit = -1
    while value >= 1024 && unit < units.count - 1 {
        value /= 1024
        unit += 1
    }
    let formatted: String
    if value >= 10 {
        formatted = String(Int(value.rounded()))
    } else {
        var text = String(format: "%.1f", value)
        if text.hasSuffix(".0") { text = String(text.dropLast(2)) }
        formatted = text
    }
    return "\(formatted) \(units[unit])"
}

/// `12/31/2026, 10:03 · 1.2 KB`-style joined metadata line
/// (web `formatFileMetadata`); `modified` is epoch ms.
func formatFileMetadata(size: Int?, modified: Double?) -> String? {
    let time = modified.map { epochMs in
        Date(timeIntervalSince1970: epochMs / 1000)
            .formatted(date: .numeric, time: .shortened)
    }
    let parts = [time, formatFileSize(size)].compactMap { $0 }
    let joined = parts.joined(separator: " · ")
    return joined.isEmpty ? nil : joined
}

/// Single status letter of the Changes list (web `StatusBadge`).
func gitStatusLetter(_ status: GitFileChange) -> String {
    switch status {
    case .added: "A"
    case .deleted: "D"
    case .renamed: "R"
    case .untracked: "?"
    case .conflicted: "U"
    case .modified: "M"
    }
}

/// Badge tint per status, tuned per appearance (web `--app-git-*-color`
/// vars; same values as the Android port).
func gitStatusColor(_ status: GitFileChange, dark: Bool) -> Color {
    switch status {
    case .added: dark ? Color(hex: 0x4CC38A) : Color(hex: 0x1A7F37)
    case .deleted, .conflicted: dark ? Color(hex: 0xF47067) : Color(hex: 0xCF222E)
    case .renamed: dark ? Color(hex: 0xDBAB0A) : Color(hex: 0x9A6700)
    case .untracked: dark ? Color(hex: 0x8E8E93) : Color(hex: 0x6B7280)
    case .modified: dark ? Color(hex: 0x539BF5) : Color(hex: 0x0969DA)
    }
}

extension Color {
    /// `0xRRGGBB` literal → opaque sRGB color.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
