import SwiftUI

/// Semantic color + typography tokens for the HAPI rendering components.
///
/// Three fixed palettes are provided: `.light`, `.dark`, and `.oled`
/// (dark with pure-black backgrounds for OLED displays). The app injects
/// the palette via the environment (`.hapiTheme(_:)`); components read it
/// through `@Environment(\.hapiTheme)`.
///
/// Deliberately minimal — plain value type, fixed token set, no theming DSL.
public struct HapiTheme: Equatable, Sendable {
    public enum Variant: String, Equatable, Sendable {
        case light
        case dark
        case oled
    }

    public var variant: Variant

    // MARK: Core surfaces & text

    public var background: Color
    public var surface: Color
    public var textPrimary: Color
    public var textSecondary: Color
    public var textHint: Color
    public var divider: Color

    // MARK: Semantic accents

    public var accent: Color
    public var link: Color
    public var success: Color
    public var warning: Color
    public var danger: Color

    // MARK: Code

    public var codeBackground: Color
    public var codeHeaderBackground: Color
    public var inlineCodeBackground: Color
    public var inlineCodeForeground: Color

    // MARK: Markdown blocks

    public var quoteBar: Color
    public var quoteBackground: Color
    public var tableHeaderBackground: Color

    // MARK: Diff

    public var diffAddedBackground: Color
    public var diffAddedForeground: Color
    public var diffRemovedBackground: Color
    public var diffRemovedForeground: Color
    public var hunkHeaderBackground: Color

    // MARK: Typography scale

    public var bodySize: CGFloat
    public var codeSize: CGFloat
    public var captionSize: CGFloat

    /// True for the `.dark` and `.oled` palettes (drives e.g. the
    /// highlight.js theme choice in `CodeBlockView`).
    public var isDark: Bool { variant != .light }

    public var bodyFont: Font { .system(size: bodySize) }
    public var codeFont: Font { .system(size: codeSize, design: .monospaced) }
    public var captionFont: Font { .system(size: captionSize) }
    /// Monospaced font for inline code runs inside body text.
    public var inlineCodeFont: Font { .system(size: bodySize - 1.5, design: .monospaced) }

    // MARK: - Palettes

    public static let light = HapiTheme(
        variant: .light,
        background: Color(hapiHex: 0xFFFFFF),
        surface: Color(hapiHex: 0xF6F7F9),
        textPrimary: Color(hapiHex: 0x1C1D22),
        textSecondary: Color(hapiHex: 0x52555E),
        textHint: Color(hapiHex: 0x8A8D96),
        divider: Color(hapiHex: 0xE5E7EB),
        accent: Color(hapiHex: 0x3B82F6),
        link: Color(hapiHex: 0x2563EB),
        success: Color(hapiHex: 0x16A34A),
        warning: Color(hapiHex: 0xD97706),
        danger: Color(hapiHex: 0xDC2626),
        codeBackground: Color(hapiHex: 0xF6F8FA),
        codeHeaderBackground: Color(hapiHex: 0xEEF1F4),
        inlineCodeBackground: Color(hapiHex: 0xEEF1F4),
        inlineCodeForeground: Color(hapiHex: 0xB01F63),
        quoteBar: Color(hapiHex: 0xD1D5DB),
        quoteBackground: Color(hapiHex: 0xF8F9FB),
        tableHeaderBackground: Color(hapiHex: 0xF2F4F7),
        diffAddedBackground: Color(hapiHex: 0xDDF4E4),
        diffAddedForeground: Color(hapiHex: 0x116329),
        diffRemovedBackground: Color(hapiHex: 0xFFEBE9),
        diffRemovedForeground: Color(hapiHex: 0xA40E26),
        hunkHeaderBackground: Color(hapiHex: 0xF1F8FF),
        bodySize: 15,
        codeSize: 13,
        captionSize: 11
    )

    public static let dark = HapiTheme(
        variant: .dark,
        background: Color(hapiHex: 0x0F1115),
        surface: Color(hapiHex: 0x171A21),
        textPrimary: Color(hapiHex: 0xE8EAED),
        textSecondary: Color(hapiHex: 0xA8ADB8),
        textHint: Color(hapiHex: 0x6E7481),
        divider: Color(hapiHex: 0x2A2E37),
        accent: Color(hapiHex: 0x6C9EFF),
        link: Color(hapiHex: 0x7CA9FF),
        success: Color(hapiHex: 0x3FB950),
        warning: Color(hapiHex: 0xD29922),
        danger: Color(hapiHex: 0xF85149),
        codeBackground: Color(hapiHex: 0x161B22),
        codeHeaderBackground: Color(hapiHex: 0x1F242D),
        inlineCodeBackground: Color(hapiHex: 0x262C36),
        inlineCodeForeground: Color(hapiHex: 0xF585A8),
        quoteBar: Color(hapiHex: 0x3B4048),
        quoteBackground: Color(hapiHex: 0x14171C),
        tableHeaderBackground: Color(hapiHex: 0x1C2028),
        diffAddedBackground: Color(hapiHex: 0x12261E),
        diffAddedForeground: Color(hapiHex: 0x3FB950),
        diffRemovedBackground: Color(hapiHex: 0x2D1215),
        diffRemovedForeground: Color(hapiHex: 0xF85149),
        hunkHeaderBackground: Color(hapiHex: 0x161F2E),
        bodySize: 15,
        codeSize: 13,
        captionSize: 11
    )

    /// Dark palette on pure-black backgrounds (OLED power saving).
    public static let oled: HapiTheme = {
        var theme = HapiTheme.dark
        theme.variant = .oled
        theme.background = Color(hapiHex: 0x000000)
        theme.surface = Color(hapiHex: 0x0A0A0C)
        theme.codeBackground = Color(hapiHex: 0x0B0D10)
        theme.codeHeaderBackground = Color(hapiHex: 0x101318)
        theme.quoteBackground = Color(hapiHex: 0x050608)
        theme.tableHeaderBackground = Color(hapiHex: 0x101216)
        theme.divider = Color(hapiHex: 0x1F2329)
        return theme
    }()

    /// Convenience mapping from the system color scheme.
    public static func resolve(for colorScheme: ColorScheme, oledDark: Bool = false) -> HapiTheme {
        switch colorScheme {
        case .dark: return oledDark ? .oled : .dark
        default: return .light
        }
    }
}

extension Color {
    /// 0xRRGGBB constant color (sRGB, full opacity).
    init(hapiHex hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: 1.0
        )
    }
}

// MARK: - Environment plumbing

private struct HapiThemeKey: EnvironmentKey {
    static let defaultValue = HapiTheme.light
}

public extension EnvironmentValues {
    /// The active HAPI palette. Defaults to `.light`; the app is expected to
    /// inject the palette matching the system appearance at its root:
    ///
    ///     ContentView().hapiTheme(.resolve(for: colorScheme, oledDark: prefersOLED))
    var hapiTheme: HapiTheme {
        get { self[HapiThemeKey.self] }
        set { self[HapiThemeKey.self] = newValue }
    }
}

public extension View {
    /// Injects a HAPI palette for this subtree.
    func hapiTheme(_ theme: HapiTheme) -> some View {
        environment(\.hapiTheme, theme)
    }
}
