package app.hapi.companion.feature.chat.share

import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class ShareTurnFileNamesTest {

    // ------------------------------------------------------- sanitizing --

    @Test fun illegalCharactersBecomeDashesWhileSpacesSurvive() {
        assertEquals(
            "My -chat- -hello-world",
            ShareTurnFileNames.sanitizeTitle("My <chat>: \"hello/world\"?"),
        )
    }

    @Test fun runsOfSpacesCollapseToOneSpace() {
        assertEquals("a b c", ShareTurnFileNames.sanitizeTitle("a   b c"))
    }

    @Test fun titlesWithoutUsableCharactersFallBack() {
        assertEquals("Shared turn", ShareTurnFileNames.sanitizeTitle(""))
        assertEquals("Shared turn", ShareTurnFileNames.sanitizeTitle("???"))
        assertEquals("Shared turn", ShareTurnFileNames.sanitizeTitle(" / "))
    }

    @Test fun edgeDashesAndDotsAreTrimmed() {
        assertEquals("chat", ShareTurnFileNames.sanitizeTitle("  -- chat -- .."))
    }

    @Test fun controlCharactersVanishWithoutLeavingDashes() {
        assertEquals("abc", ShareTurnFileNames.sanitizeTitle("a\u0000b\tc"))
    }

    @Test fun compatibilityNormalizationFoldsFullwidthText() {
        assertEquals("Hello world", ShareTurnFileNames.sanitizeTitle("Ｈｅｌｌｏ　ｗｏｒｌｄ"))
    }

    @Test fun veryLongTitlesAreCappedByCodePoints() {
        val title = "a".repeat(79) + "😀😀"
        val sanitized = ShareTurnFileNames.sanitizeTitle(title)
        assertEquals(80, sanitized.codePointCount(0, sanitized.length))
        // The cap lands between the two surrogate pairs instead of splitting one.
        assertEquals("a".repeat(79) + "😀", sanitized)
    }

    // ---------------------------------------------------------- naming --

    @Test fun fileNamesCombinePrefixTitleAndLocalStamp() {
        assertEquals(
            "HAPI-Release Notes-20270115080000.png",
            ShareTurnFileNames.shareImageFileName("Release Notes", 1_800_000_000_000L, ZoneOffset.UTC),
        )
    }

    @Test fun blankTitlesKeepTheFallbackSegment() {
        // The fallback title runs through the same pipeline as any title.
        assertEquals(
            "HAPI-Shared turn-20270115080000.png",
            ShareTurnFileNames.shareImageFileName("  ", 1_800_000_000_000L, ZoneOffset.UTC),
        )
    }

    @Test fun theStampFollowsTheProvidedZone() {
        val title = "Notes"
        assertEquals(
            "HAPI-Notes-20270115160000.png",
            ShareTurnFileNames.shareImageFileName(title, 1_800_000_000_000L, ZoneOffset.ofHours(8)),
        )
        val utc = ShareTurnFileNames.shareImageFileName(title, 1_800_000_000_000L, ZoneOffset.UTC)
        val ahead = ShareTurnFileNames.shareImageFileName(title, 1_800_000_000_000L, ZoneOffset.ofHours(8))
        assertNotEquals(utc, ahead)
        assertTrue(utc.endsWith(".png"))
    }
}
