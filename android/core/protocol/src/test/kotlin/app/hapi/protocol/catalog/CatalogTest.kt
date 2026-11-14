package app.hapi.protocol.catalog

import app.hapi.protocol.wire.HapiJson
import java.io.File
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Catalog data pinned against `shared/src/modes.ts`, `shared/src/copilotModes.ts`
 * and `shared/src/flavors.ts`.
 * Also checks the generated modes catalog so new flavors cannot silently drift.
 */
class CatalogTest {

    @Test
    fun `permission catalogs match generated fixtures exactly`() {
        val fixturesDir = requireNotNull(System.getProperty("hapi.fixtures.dir"))
        val catalog = HapiJson.parseToJsonElement(
            File(fixturesDir, "catalogs/modes.json").readText()
        ).jsonObject.getValue("permissionModesByFlavor").jsonObject
        assertEquals(AgentFlavor.KNOWN.map { it.id }.toSet(), catalog.keys)
        for ((flavor, entries) in catalog) {
            val expected = entries.jsonArray.map { it.jsonObject }
            val actual = PermissionModes.forFlavor(flavor)
            assertEquals(expected.map { it.getValue("mode").jsonPrimitive.content }, actual.map { it.wireId }, flavor)
            assertEquals(expected.map { it.getValue("label").jsonPrimitive.content }, actual.map { it.label }, flavor)
            assertEquals(expected.map { it.getValue("tone").jsonPrimitive.content }, actual.map { it.tone.name.lowercase() }, flavor)
        }
    }

    @Test
    fun `permission mode ids follow PERMISSION_MODES declaration order`() {
        assertEquals(
            listOf(
                "default", "acceptEdits", "auto", "bypassPermissions", "plan",
                "ask", "debug", "autoReview", "read-only", "safe-yolo", "yolo",
                "request-review", "always-proceed",
            ),
            PermissionMode.entries.map { it.wireId }
        )
    }

    @Test
    fun `labels and tones match modes-ts`() {
        assertEquals("Yolo", PermissionMode.BypassPermissions.label)
        assertEquals(PermissionModeTone.Danger, PermissionMode.BypassPermissions.tone)
        assertEquals("Plan Mode", PermissionMode.Plan.label)
        assertEquals(PermissionModeTone.Info, PermissionMode.Plan.tone)
        assertEquals("Accept Edits", PermissionMode.AcceptEdits.label)
        assertEquals(PermissionModeTone.Warning, PermissionMode.AcceptEdits.tone)
        assertEquals("Auto", PermissionMode.AutoReview.label)
        assertEquals("Read Only", PermissionMode.ReadOnly.label)
        assertEquals(PermissionModeTone.Neutral, PermissionMode.Default.tone)
        assertEquals(PermissionModeTone.Danger, PermissionMode.AlwaysProceed.tone)
    }

    @Test
    fun `per-flavor mode lists match getPermissionModesForFlavor`() {
        assertEquals(
            listOf("default", "acceptEdits", "auto", "bypassPermissions", "plan"),
            PermissionModes.forFlavor("claude").map { it.wireId }
        )
        assertEquals(
            listOf("default", "read-only", "autoReview", "yolo"),
            PermissionModes.forFlavor("codex").map { it.wireId }
        )
        assertEquals(
            listOf("default", "read-only", "safe-yolo", "yolo"),
            PermissionModes.forFlavor("gemini").map { it.wireId }
        )
        // hermes/kimi/copilot share the gemini list.
        assertEquals(PermissionModes.forFlavor("gemini"), PermissionModes.forFlavor("hermes"))
        assertEquals(PermissionModes.forFlavor("gemini"), PermissionModes.forFlavor("kimi"))
        assertEquals(PermissionModes.forFlavor("gemini"), PermissionModes.forFlavor("copilot"))
        assertEquals(
            listOf("default", "auto", "plan", "bypassPermissions"),
            PermissionModes.forFlavor("grok").map { it.wireId }
        )
        assertEquals(
            listOf("default", "plan", "yolo"),
            PermissionModes.forFlavor("opencode").map { it.wireId }
        )
        assertEquals(
            listOf("request-review", "acceptEdits", "plan", "always-proceed"),
            PermissionModes.forFlavor("agy").map { it.wireId }
        )
        assertEquals(
            listOf("default", "plan", "ask", "debug", "autoReview", "yolo"),
            PermissionModes.forFlavor("cursor").map { it.wireId }
        )
        // Pi has no runtime permission switching.
        assertTrue(PermissionModes.forFlavor("pi").isEmpty())
        // Unknown / null flavors fall back to the Claude list.
        assertEquals(PermissionModes.CLAUDE, PermissionModes.forFlavor(null))
        assertEquals(PermissionModes.CLAUDE, PermissionModes.forFlavor("mystery-agent"))
    }

    @Test
    fun `mode allowance mirrors isPermissionModeAllowedForFlavor`() {
        assertTrue(PermissionModes.isAllowedForFlavor(PermissionMode.Plan, "claude"))
        assertFalse(PermissionModes.isAllowedForFlavor(PermissionMode.AcceptEdits, "codex"))
        assertFalse(PermissionModes.isAllowedForFlavor(PermissionMode.Yolo, "pi"))
    }

    @Test
    fun `agent flavors match AGENT_FLAVORS and CREATABLE excludes gemini`() {
        assertEquals(
            listOf("agy", "claude", "codex", "dsh", "copilot", "cursor", "gemini", "grok", "hermes", "kimi", "opencode", "pi"),
            AgentFlavor.KNOWN.map { it.id }
        )
        assertFalse(AgentFlavor.CREATABLE.contains(AgentFlavor.Gemini))
        assertEquals(AgentFlavor.KNOWN.size - 1, AgentFlavor.CREATABLE.size)
        assertEquals(AgentFlavor.Claude, AgentFlavor.from("claude"))
        assertEquals(AgentFlavor.Other("newagent"), AgentFlavor.from("newagent"))
        assertNull(AgentFlavor.from(null))
        assertTrue(AgentFlavor.isKnown("pi"))
        assertFalse(AgentFlavor.isKnown("newagent"))
    }

    @Test
    fun `flavor capabilities and labels match flavors-ts`() {
        assertTrue(Flavors.supportsEffort("claude"))
        assertTrue(Flavors.supportsEffort("grok"))
        assertTrue(Flavors.supportsEffort("pi"))
        assertFalse(Flavors.supportsEffort("codex"))
        assertFalse(Flavors.supportsEffort(null))
        assertTrue(AgentFlavor.KNOWN.filter { it != AgentFlavor.Dsh }.all { Flavors.supportsModelChange(it.id) })
        assertFalse(Flavors.supportsModelChange("dsh"))
        assertFalse(Flavors.supportsModelChange("unknown"))
        assertEquals("Antigravity", Flavors.label("agy"))
        assertEquals("Hermes", Flavors.label("hermes"))
        assertTrue(Flavors.isCodexFamily("hermes"))
        assertEquals("Grok Build", Flavors.label("grok"))
        assertEquals("OpenCode", Flavors.label("opencode"))
        assertEquals("DeepSeek Harness", Flavors.label("dsh"))
        assertEquals("Unknown", Flavors.label("mystery"))
        assertTrue(Flavors.isCodexFamily("copilot"))
        assertFalse(Flavors.isCodexFamily("claude"))
        assertFalse(Flavors.isCodexFamily("cursor"))
        assertFalse(Flavors.isCodexFamily("pi"))
    }

    @Test
    fun `collaboration and copilot agent modes match the ts catalogs`() {
        assertEquals(listOf("default", "plan"), CodexCollaborationMode.entries.map { it.wireId })
        assertEquals("Plan", CodexCollaborationMode.Plan.label)

        assertEquals(listOf("interactive", "plan", "autopilot"), CopilotAgentMode.entries.map { it.wireId })
        assertEquals("Autopilot", CopilotAgentMode.Autopilot.label)
        // Legacy 'fleet' (and anything invalid) coerces to Interactive.
        assertEquals(CopilotAgentMode.Interactive, CopilotAgentMode.normalize("fleet"))
        assertEquals(CopilotAgentMode.Interactive, CopilotAgentMode.normalize("nonsense"))
        assertEquals(CopilotAgentMode.Interactive, CopilotAgentMode.normalize(null))
        assertEquals(CopilotAgentMode.Plan, CopilotAgentMode.normalize("plan"))
    }
}
