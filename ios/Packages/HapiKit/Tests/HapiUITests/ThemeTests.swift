import SwiftUI
import HapiUI
import Testing

@Suite("HapiTheme")
struct ThemeTests {
    @Test func variantsAndDarkFlag() {
        #expect(HapiTheme.light.variant == .light)
        #expect(HapiTheme.dark.variant == .dark)
        #expect(HapiTheme.oled.variant == .oled)
        #expect(!HapiTheme.light.isDark)
        #expect(HapiTheme.dark.isDark)
        #expect(HapiTheme.oled.isDark)
    }

    @Test func oledUsesPureBlackBackground() {
        #expect(HapiTheme.oled.background == Color(.sRGB, red: 0, green: 0, blue: 0, opacity: 1))
        // Everything else inherits the dark palette.
        #expect(HapiTheme.oled.textPrimary == HapiTheme.dark.textPrimary)
        #expect(HapiTheme.oled.diffAddedBackground == HapiTheme.dark.diffAddedBackground)
    }

    @Test func palettesAreDistinct() {
        #expect(HapiTheme.light != HapiTheme.dark)
        #expect(HapiTheme.dark != HapiTheme.oled)
    }

    @Test func resolveMapsColorScheme() {
        #expect(HapiTheme.resolve(for: .light) == .light)
        #expect(HapiTheme.resolve(for: .dark) == .dark)
        #expect(HapiTheme.resolve(for: .dark, oledDark: true) == .oled)
        #expect(HapiTheme.resolve(for: .light, oledDark: true) == .light)
    }
}
