import Foundation
import SwiftUI
import Highlightr
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// MARK: - SyntaxHighlighting protocol

/// Pluggable code highlighter. `CodeBlockView` talks to this protocol only,
/// so the Highlightr-backed engine can be replaced (or stubbed in tests)
/// without touching any view code.
public protocol SyntaxHighlighting: Sendable {
    /// Returns highlighted text, or nil when the input should render as
    /// plain monospaced text (unknown language, oversized input, engine
    /// unavailable). Synchronous; may be slow — call off the main thread.
    func highlight(_ code: String, language: String?, dark: Bool) -> AttributedString?
}

public extension SyntaxHighlighting {
    /// Runs `highlight` on a background task so view code never blocks the
    /// main thread on JavaScriptCore.
    func highlightAsync(_ code: String, language: String?, dark: Bool) async -> AttributedString? {
        let engine = self
        return await Task.detached(priority: .utility) {
            engine.highlight(code, language: language, dark: dark)
        }.value
    }
}

// MARK: - HighlightrEngine

/// highlight.js via Highlightr (JavaScriptCore). Lazy shared instance, results
/// cached by (code, language, theme); inputs beyond
/// `highlightedLineLimit` lines are returned as plain text (nil) to keep the
/// JS pass bounded.
public final class HighlightrEngine: SyntaxHighlighting, @unchecked Sendable {
    public static let shared = HighlightrEngine()

    /// Above this many lines the code renders unhighlighted.
    public static let highlightedLineLimit = 400

    private static let lightThemeName = "xcode"
    private static let darkThemeName = "atom-one-dark"

    private final class CachedHighlight {
        let value: AttributedString
        init(_ value: AttributedString) { self.value = value }
    }

    private let lock = NSLock()
    private var engine: Highlightr?
    private var engineLoadFailed = false
    private var appliedDarkTheme: Bool?
    private let cache = NSCache<NSString, CachedHighlight>()

    public init() {
        cache.countLimit = 64
    }

    public func highlight(_ code: String, language: String?, dark: Bool) -> AttributedString? {
        guard let language, !language.isEmpty else { return nil }
        let lang = language.lowercased()
        if lang == "text" || lang == "plain" || lang == "plaintext" || lang == "txt" {
            return nil
        }

        // Cheap line cap before any JS work.
        var newlines = 0
        for byte in code.utf8 where byte == 0x0A {
            newlines += 1
            if newlines > Self.highlightedLineLimit { return nil }
        }

        let key = "\(lang)|\(dark ? "d" : "l")|\(code.count)|\(code.hashValue)" as NSString
        if let hit = cache.object(forKey: key) {
            return hit.value
        }

        // Highlightr wraps a single JSContext — serialize all access.
        lock.lock()
        defer { lock.unlock() }

        if engine == nil && !engineLoadFailed {
            engine = Highlightr()
            engineLoadFailed = (engine == nil)
        }
        guard let engine else { return nil }

        if appliedDarkTheme != dark {
            engine.setTheme(to: dark ? Self.darkThemeName : Self.lightThemeName)
            appliedDarkTheme = dark
        }

        guard let highlighted = engine.highlight(code, as: lang, fastRender: true) else {
            return nil
        }

        let converted = Self.convertToSwiftUIColors(highlighted)
        cache.setObject(CachedHighlight(converted), forKey: key)
        return converted
    }

    /// `NSAttributedString(...)` → `AttributedString` keeps platform colors in
    /// the UIKit/AppKit attribute scopes, which SwiftUI `Text` ignores.
    /// Rebuild the string run-by-run with the colors copied into the SwiftUI
    /// scope (rebuilding avoids mutating while iterating runs). Fonts are
    /// dropped on purpose — the view applies the theme's monospaced font.
    private static func convertToSwiftUIColors(_ source: NSAttributedString) -> AttributedString {
        let attributed = AttributedString(source)
        var output = AttributedString()
        for run in attributed.runs {
            var piece = AttributedString(String(attributed.characters[run.range]))
            var color: Color? = nil
            #if canImport(UIKit)
            if let platformColor = run[AttributeScopes.UIKitAttributes.ForegroundColorAttribute.self] {
                color = Color(uiColor: platformColor)
            }
            #elseif canImport(AppKit)
            if let platformColor = run[AttributeScopes.AppKitAttributes.ForegroundColorAttribute.self] {
                color = Color(nsColor: platformColor)
            }
            #endif
            if let color {
                piece[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = color
            }
            output.append(piece)
        }
        return output
    }
}

// MARK: - Pasteboard abstraction

/// Tiny seam over the system pasteboard so copy behavior is testable and no
/// view depends on UIKit directly.
public protocol PasteboardWriting: Sendable {
    @MainActor func copy(_ string: String)
}

public struct SystemPasteboard: PasteboardWriting {
    public init() {}

    @MainActor public func copy(_ string: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = string
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        #endif
    }
}

// MARK: - Environment plumbing

private struct HapiSyntaxHighlighterKey: EnvironmentKey {
    static var defaultValue: any SyntaxHighlighting { HighlightrEngine.shared }
}

private struct HapiPasteboardKey: EnvironmentKey {
    static var defaultValue: any PasteboardWriting { SystemPasteboard() }
}

public extension EnvironmentValues {
    /// The highlighter used by `CodeBlockView`. Defaults to the shared
    /// Highlightr engine; inject a stub for tests/previews.
    var hapiSyntaxHighlighter: any SyntaxHighlighting {
        get { self[HapiSyntaxHighlighterKey.self] }
        set { self[HapiSyntaxHighlighterKey.self] = newValue }
    }

    /// The pasteboard used by copy buttons.
    var hapiPasteboard: any PasteboardWriting {
        get { self[HapiPasteboardKey.self] }
        set { self[HapiPasteboardKey.self] = newValue }
    }
}
