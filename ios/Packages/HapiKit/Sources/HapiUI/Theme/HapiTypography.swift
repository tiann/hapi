import SwiftUI

/// Resolved once at the presentation root; never scale these values again.
/// Separate from color palettes so light, dark and OLED have identical metrics.
public struct HapiTypography: Equatable, Sendable {
    public var bodyScale: CGFloat
    public var codeScale: CGFloat
    public var captionScale: CGFloat
    public var boldText: Bool

    public init(bodyScale: CGFloat = 1, codeScale: CGFloat = 1,
                captionScale: CGFloat = 1, boldText: Bool = false) {
        self.bodyScale = bodyScale
        self.codeScale = codeScale
        self.captionScale = captionScale
        self.boldText = boldText
    }

    public var bodySize: CGFloat { 16 * bodyScale }
    public var codeSize: CGFloat { 14 * codeScale }
    public var captionSize: CGFloat { 12 * captionScale }
    public var inlineCodeSize: CGFloat { 15 * bodyScale }
    public var bodyLineSpacing: CGFloat { 3 * bodyScale }
    public var codeLineSpacing: CGFloat { 2 * codeScale }
    public var bodyFont: Font { .system(size: bodySize, weight: regularWeight) }
    public var codeFont: Font { .system(size: codeSize, weight: regularWeight, design: .monospaced) }
    public var captionFont: Font { .system(size: captionSize, weight: regularWeight) }
    public var inlineCodeFont: Font { .system(size: inlineCodeSize, weight: regularWeight, design: .monospaced) }
    public var captionMonoFont: Font { .system(size: captionSize, weight: regularWeight, design: .monospaced) }

    private var regularWeight: Font.Weight { boldText ? .semibold : .regular }

    public func headingSize(_ level: Int) -> CGFloat {
        let base: CGFloat = switch level {
        case 1: 24
        case 2: 20
        case 3: 18
        default: 17
        }
        return base * bodyScale
    }

    public func headingFont(_ level: Int) -> Font {
        .system(size: headingSize(level), weight: boldText ? .bold : .semibold)
    }
}

private struct HapiTypographyKey: EnvironmentKey {
    static let defaultValue = HapiTypography()
}

public extension EnvironmentValues {
    var hapiTypography: HapiTypography {
        get { self[HapiTypographyKey.self] }
        set { self[HapiTypographyKey.self] = newValue }
    }
}

private struct HapiTypographyModifier: ViewModifier {
    @ScaledMetric(relativeTo: .body) private var bodyScale: CGFloat = 1
    @ScaledMetric(relativeTo: .footnote) private var codeScale: CGFloat = 1
    @ScaledMetric(relativeTo: .caption) private var captionScale: CGFloat = 1
    @Environment(\.legibilityWeight) private var legibilityWeight

    func body(content: Content) -> some View {
        content.environment(\.hapiTypography, HapiTypography(
            bodyScale: bodyScale, codeScale: codeScale, captionScale: captionScale,
            boldText: legibilityWeight == .bold
        ))
    }
}

public enum HapiReadingLayout {
    public static let horizontalInset: CGFloat = 16
    public static let maximumWidth: CGFloat = 720

    public static func contentWidth(in availableWidth: CGFloat) -> CGFloat {
        max(1, min(maximumWidth, availableWidth - 2 * horizontalInset))
    }
}

public extension View {
    /// Install outside the chat list so hosted rows inherit resolved metrics.
    func hapiTypography() -> some View { modifier(HapiTypographyModifier()) }

    func hapiReadingColumn(horizontalInset: CGFloat = HapiReadingLayout.horizontalInset) -> some View {
        frame(maxWidth: HapiReadingLayout.maximumWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, horizontalInset)
    }
}
