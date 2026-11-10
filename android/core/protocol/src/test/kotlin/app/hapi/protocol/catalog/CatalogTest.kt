package app.hapi.protocol.catalog

import app.hapi.protocol.wire.HapiJson
import java.io.File
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Catalog data pinned against `shared/src/modes.ts`, `shared/src/copilotModes.ts`
 * and `shared/src/flavors.ts`.
 *
 * The exhaustive cross-check runs against the generated catalog
 * `shared/fixtures/catalogs/modes.json` (track K, from `shared/src/modes.ts`),
 * so catalog drift — including new flavor registrations like berry/hermes —
 * turns this suite red automatically; the inline expectations below stay for
 * fast diagnosis when the generated catalog and the port disagree.
 */
class CatalogTest {

    // ---------------------------------------------- generated catalog parity --

    @Test
    fun `port matches the generated modes catalog exactly`() {
        val fixturesDir = System.getProperty("hapi.fixtures.dir")
        assertNotNull(fixturesDir, "hapi.fixtures.dir system property not set (see core/protocol/build.gradle.kts)")
        val catalogFile = File(fixturesDir, "catalogs/modes.json")
        assertTrue(catalogFile.isFile, "generated modes catalog not found: $catalogFile")
        val catalog = HapiJson.parseToJsonElement(catalogFile.readText())
        val byFlavor = catalog.jsonObject["permissionModesByFlavor"]!!.jsonObject

        // 生成目录只携带已知 flavor:两边必须逐一对齐(新增 flavor 注册漏改
        // 任一侧都会在这里红)。
        assertEquals(
            AgentFlavor.KNOWN.map { it.id }.sorted(),
            byFlavor.keys.sorted(),
        )

        val toneByName = mapOf(
            "neutral" to PermissionModeTone.Neutral,
            "info" to PermissionModeTone.Info,
            "warning" to PermissionModeTone.Warning,
            "danger" to PermissionModeTone.Danger,
        )
        for ((flavor, modesJson) in byFlavor.entries.sortedBy { it.key }) {
            val expected = modesJson.jsonArray.map { entry ->
                val obj = entry.jsonObject
                Triple(
                    obj["mode"]!!.jsonPrimitive.content,
                    obj["label"]!!.jsonPrimitive.content,
                    obj["tone"]!!.jsonPrimitive.content,
                )
            }
            val actual = PermissionModes.forFlavor(flavor)
            assertEquals(
                expected.map { it.first },
                actual.map { it.wireId },
                "mode list mismatch for flavor $flavor",
            )
            expected.zip(actual).forEach { (exp, act) ->
                assertEquals(exp.second, act.label, "label mismatch for $flavor/${exp.first}")
                assertEquals(toneByName.getValue(exp.third), act.tone, "tone mismatch for $flavor/${exp.first}")
            }
        }

        val collaboration = catalog.jsonObject["codexCollaborationModes"]!!.jsonArray
        assertEquals(
            collaboration.map { it.jsonObject["mode"]!!.jsonPrimitive.content },
            CodexCollaborationMode.entries.map { it.wireId },
        )
        collaboration.forEach { entry ->
            val obj = entry.jsonObject
            assertEquals(
                obj["label"]!!.jsonPrimitive.content,
                CodexCollaborationMode.fromWireId(obj["mode"]!!.jsonPrimitive.content)!!.label,
            )
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
        // kimi/copilot share the gemini list.
        assertEquals(PermissionModes.forFlavor("gemini"), PermissionModes.forFlavor("kimi"))
        assertEquals(PermissionModes.forFlavor("gemini"), PermissionModes.forFlavor("copilot"))
        // berry shares the gemini shape but keeps its own constant
        // (`BERRY_PERMISSION_MODES`); hermes drops read-only (no native
        // read-only sandbox on its ACP mode axis).
        assertEquals(
            listOf("default", "read-only", "safe-yolo", "yolo"),
            PermissionModes.forFlavor("berry").map { it.wireId }
        )
        assertEquals(
            listOf("default", "safe-yolo", "yolo"),
            PermissionModes.forFlavor("hermes").map { it.wireId }
        )
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
            listOf(
                "agy", "berry", "claude", "codex", "dsh", "copilot", "cursor",
                "gemini", "grok", "hermes", "kimi", "opencode", "pi",
            ),
            AgentFlavor.KNOWN.map { it.id }
        )
        assertFalse(AgentFlavor.CREATABLE.contains(AgentFlavor.Gemini))
        assertEquals(AgentFlavor.KNOWN.size - 1, AgentFlavor.CREATABLE.size)
        assertEquals(AgentFlavor.Claude, AgentFlavor.from("claude"))
        assertEquals(AgentFlavor.Berry, AgentFlavor.from("berry"))
        assertEquals(AgentFlavor.Hermes, AgentFlavor.from("hermes"))
        assertEquals(AgentFlavor.Other("newagent"), AgentFlavor.from("newagent"))
        assertNull(AgentFlavor.from(null))
        assertTrue(AgentFlavor.isKnown("pi"))
        assertTrue(AgentFlavor.isKnown("berry"))
        assertTrue(AgentFlavor.isKnown("hermes"))
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
        assertTrue(Flavors.supportsModelChange("berry"))
        assertTrue(Flavors.supportsModelChange("hermes"))
        assertEquals("Antigravity", Flavors.label("agy"))
        assertEquals("Grok Build", Flavors.label("grok"))
        assertEquals("OpenCode", Flavors.label("opencode"))
        assertEquals("DeepSeek Harness", Flavors.label("dsh"))
        assertEquals("Berry Agent", Flavors.label("berry"))
        assertEquals("Hermes", Flavors.label("hermes"))
        assertEquals("Unknown", Flavors.label("mystery"))
        assertTrue(Flavors.isCodexFamily("copilot"))
        assertFalse(Flavors.isCodexFamily("claude"))
        assertFalse(Flavors.isCodexFamily("cursor"))
        assertFalse(Flavors.isCodexFamily("pi"))
        // hermes/berry 走通用 ACP 信封,不属于 codex 家族权限 UX。
        assertFalse(Flavors.isCodexFamily("hermes"))
        assertFalse(Flavors.isCodexFamily("berry"))
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
