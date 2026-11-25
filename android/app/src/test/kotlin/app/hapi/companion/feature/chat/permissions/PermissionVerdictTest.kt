package app.hapi.companion.feature.chat.permissions

import app.hapi.protocol.chat.ToolPermission
import app.hapi.protocol.wire.HapiJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** [PermissionVerdicts] vs `web PermissionFooter.tsx formatPermissionSummary`. */
class PermissionVerdictTest {
    private fun permission(
        status: String,
        reason: String? = null,
        mode: String? = null,
        decision: String? = null,
        allowedTools: List<String>? = null,
    ): ToolPermission = ToolPermission(
        id = "p1",
        status = status,
        reason = reason,
        mode = mode,
        allowedTools = allowedTools,
        decision = decision,
        presence = ToolPermission.COMPLETED_KEYS,
    )

    private fun classify(
        permission: ToolPermission,
        toolName: String = "Bash",
        input: String? = null,
        flavor: String? = "claude",
    ): PermissionVerdict = PermissionVerdicts.classify(
        permission, toolName,
        input?.let { HapiJson.parseToJsonElement(it) },
        flavor,
    )

    @Test fun terminalStatusesShortCircuit() {
        assertEquals(PermissionVerdictLabel.RESOLVED, classify(permission("resolved")).label)
        assertEquals(PermissionVerdictLabel.WAITING_FOR_APPROVAL, classify(permission("pending")).label)
        assertEquals(PermissionVerdict(PermissionVerdictLabel.CANCELED), classify(permission("canceled")))
        assertEquals(
            PermissionVerdict(PermissionVerdictLabel.CANCELED, "user closed the panel"),
            classify(permission("canceled", reason = "user closed the panel")),
        )
    }

    @Test fun codexApprovedDecisionDistinguishesForSession() {
        assertEquals(
            PermissionVerdictLabel.APPROVED_FOR_SESSION,
            classify(permission("approved", decision = "approved_for_session"), flavor = "codex").label,
        )
        assertEquals(PermissionVerdictLabel.APPROVED, classify(permission("approved"), flavor = "codex").label)
    }

    @Test fun codexDeniedAbortBecomesAborted() {
        assertEquals(
            PermissionVerdict(PermissionVerdictLabel.ABORTED, "too risky"),
            classify(permission("denied", reason = "too risky", decision = "abort"), flavor = "codex"),
        )
        assertEquals(
            PermissionVerdict(PermissionVerdictLabel.ABORTED),
            classify(permission("denied", decision = "abort"), flavor = "codex"),
        )
        assertEquals(
            PermissionVerdict(PermissionVerdictLabel.DENIED, "nope"),
            classify(permission("denied", reason = "nope"), flavor = "codex"),
        )
    }

    @Test fun codexSessionDetectedByFlavorFamilyAndToolPrefixes() {
        for (flavor in listOf("codex", "gemini", "grok", "kimi", "copilot", "opencode", "cursor")) {
            assertTrue(PermissionVerdicts.isCodexSession(flavor, "shell"), "flavor=$flavor")
        }
        for (tool in listOf("CodexTodo", "GeminiSearch", "OpenCodeRun", "CopilotEdit", "CursorCreatePlan")) {
            assertTrue(PermissionVerdicts.isCodexSession(null, tool), "tool=$tool")
        }
        assertFalse(PermissionVerdicts.isCodexSession("claude", "Bash"))
        assertFalse(PermissionVerdicts.isCodexSession(null, "Bash"))
    }

    @Test fun claudeApprovedModeAcceptEditsWinsOverDecision() {
        assertEquals(
            PermissionVerdictLabel.APPROVED_ALLOW_ALL_EDITS,
            classify(permission("approved", mode = "acceptEdits", decision = "approved_for_session")).label,
        )
        assertEquals(
            PermissionVerdictLabel.APPROVED_ALLOW_ALL_EDITS,
            classify(permission("approved", mode = "acceptEdits")).label,
        )
    }

    @Test fun claudeApprovedForSessionByDecision() {
        assertEquals(
            PermissionVerdictLabel.APPROVED_FOR_SESSION,
            classify(permission("approved", decision = "approved_for_session")).label,
        )
    }

    @Test fun claudeApprovedForSessionByAllowedToolsHit() {
        assertEquals(
            PermissionVerdictLabel.APPROVED_FOR_SESSION,
            classify(permission("approved", allowedTools = listOf("WebFetch")), toolName = "WebFetch").label,
        )
    }

    @Test fun claudeApprovedForSessionByBashCommandQualifier() {
        val input = """{"command":"bun test --watch"}"""
        assertEquals(
            PermissionVerdictLabel.APPROVED_FOR_SESSION,
            classify(permission("approved", allowedTools = listOf("Bash(bun test --watch)")), input = input).label,
        )
        val cmd = """{"cmd":"rm -rf build"}"""
        assertEquals(
            PermissionVerdictLabel.APPROVED_FOR_SESSION,
            classify(permission("approved", allowedTools = listOf("Bash(rm -rf build)")), input = cmd).label,
        )
        // A different command's qualifier must NOT match.
        assertEquals(
            PermissionVerdictLabel.APPROVED,
            classify(permission("approved", allowedTools = listOf("Bash(git status)")), input = input).label,
        )
        // Non-Bash tools never consult the command qualifier.
        assertEquals(
            PermissionVerdictLabel.APPROVED,
            classify(permission("approved", allowedTools = listOf("Bash(bun test --watch)")), toolName = "Edit", input = input).label,
        )
    }

    @Test fun claudeApprovedWithoutEvidenceStaysPlainApproved() {
        assertEquals(PermissionVerdictLabel.APPROVED, classify(permission("approved")).label)
        assertEquals(PermissionVerdictLabel.APPROVED, classify(permission("approved", allowedTools = emptyList())).label)
        assertEquals(PermissionVerdictLabel.APPROVED, classify(permission("approved", allowedTools = listOf("Other"))).label)
        assertEquals(PermissionVerdictLabel.APPROVED, classify(permission("approved", mode = "default")).label)
    }

    @Test fun deniedCarriesReason() {
        assertEquals(
            PermissionVerdict(PermissionVerdictLabel.DENIED, "not allowed"),
            classify(permission("denied", reason = "not allowed")),
        )
        assertEquals(PermissionVerdict(PermissionVerdictLabel.DENIED), classify(permission("denied")))
    }

    @Test fun isToolAllowedForSessionEdges() {
        assertFalse(PermissionVerdicts.isToolAllowedForSession("Bash", null, null))
        assertFalse(PermissionVerdicts.isToolAllowedForSession("Bash", null, emptyList()))
        // Bash without a resolvable command cannot match a qualifier.
        assertFalse(
            PermissionVerdicts.isToolAllowedForSession(
                "Bash",
                HapiJson.parseToJsonElement("""{"command":""}"""),
                listOf("Bash()"),
            ),
        )
        assertTrue(
            PermissionVerdicts.isToolAllowedForSession(
                "Bash",
                HapiJson.parseToJsonElement("""{"command":"ls"}"""),
                listOf("Bash(ls)"),
            ),
        )
    }

    @Test fun unknownStatusFallsBackToAllowLabel() {
        assertEquals(
            PermissionVerdict(PermissionVerdictLabel.ALLOW),
            classify(permission("weird-future-status")),
        )
        assertNull(classify(permission("weird-future-status")).reason)
    }
}
