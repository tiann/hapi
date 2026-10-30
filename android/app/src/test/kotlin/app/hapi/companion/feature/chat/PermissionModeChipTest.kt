package app.hapi.companion.feature.chat

import app.hapi.protocol.catalog.PermissionMode
import app.hapi.protocol.catalog.PermissionModes
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Display rule for the persistent permission-mode chip — mirrors the web
 * StatusBar predicate (StatusBar.tsx:253-261).
 */
class PermissionModeChipTest {

    @Test fun defaultHidesEverywhereExceptCopilot() {
        assertNull(PermissionModeChipRule.displayMode("default", "claude"))
        assertNull(PermissionModeChipRule.displayMode("default", "codex"))
        assertNull(PermissionModeChipRule.displayMode("default", null))
        assertEquals(PermissionMode.Default, PermissionModeChipRule.displayMode("default", "copilot"))
    }

    @Test fun nonDefaultModeShowsWhenTheFlavorOffersIt() {
        assertEquals(PermissionMode.AcceptEdits, PermissionModeChipRule.displayMode("acceptEdits", "claude"))
        assertEquals(PermissionMode.ReadOnly, PermissionModeChipRule.displayMode("read-only", "codex"))
        assertEquals(PermissionMode.Plan, PermissionModeChipRule.displayMode("plan", null))
        assertEquals(PermissionMode.AlwaysProceed, PermissionModeChipRule.displayMode("always-proceed", "agy"))
    }

    @Test fun modeOutsideTheFlavorListHides() {
        // acceptEdits is claude-only; a stale value on a codex session hides.
        assertNull(PermissionModeChipRule.displayMode("acceptEdits", "codex"))
        assertNull(PermissionModeChipRule.displayMode("read-only", "claude"))
    }

    @Test fun piOffersNoModesAndDshMirrorsTheCatalog() {
        // Pi has no runtime permission switching in any tree.
        assertNull(PermissionModeChipRule.displayMode("acceptEdits", "pi"))
        assertNull(PermissionModeChipRule.displayMode("default", "pi"))
        // The chip mirrors whatever the flavor catalog offers, and dsh's
        // offered list may gain modes (a codex-style set) — derive the
        // expectation from the catalog instead of hardcoding "no modes".
        val dshOffersYolo = PermissionModes.forFlavor("dsh").contains(PermissionMode.Yolo)
        assertEquals(
            PermissionMode.Yolo.takeIf { dshOffersYolo },
            PermissionModeChipRule.displayMode("yolo", "dsh"),
        )
    }

    @Test fun unknownWireIdAndNullModeHide() {
        assertNull(PermissionModeChipRule.displayMode("future-mode", "claude"))
        assertNull(PermissionModeChipRule.displayMode(null, "claude"))
        assertNull(PermissionModeChipRule.displayMode("", "copilot"))
    }
}
