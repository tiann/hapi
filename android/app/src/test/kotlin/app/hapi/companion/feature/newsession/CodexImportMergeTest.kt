package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.CodexDuplicateSessionGroup
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Pure-semantics pin of the duplicate-merge helpers (slice B) against
 * `web/src/components/NewSession/codexImportMerge.ts` and the normalizers of
 * `web/src/components/NewSession/index.tsx`.
 */
class CodexImportMergeTest {

    private val strings = CodexImportStrings()

    private fun group(
        canonicalSessionId: String? = null,
        hapiSessionIds: List<String> = emptyList(),
    ) = CodexDuplicateSessionGroup(
        codexSessionId = "c",
        hapiSessionIds = hapiSessionIds,
        canonicalSessionId = canonicalSessionId,
    )

    // ------------------------------------------------------------- redirect --

    @Test
    fun `redirect prefers the first canonical survivor`() {
        val merged = listOf(
            group(canonicalSessionId = null, hapiSessionIds = listOf("h1")),
            group(canonicalSessionId = "h9", hapiSessionIds = listOf("h2")),
        )

        assertEquals(
            "h9",
            CodexImportMerge.resolveCodexImportRedirectSessionId(merged, listOf("h0", "h1")),
        )
    }

    @Test
    fun `redirect falls back to the first imported hapi session`() {
        val merged = listOf(group(canonicalSessionId = null))

        assertEquals(
            "h0",
            CodexImportMerge.resolveCodexImportRedirectSessionId(merged, listOf("h0", "h1")),
        )
    }

    @Test
    fun `redirect is null when nothing survives and nothing was imported`() {
        assertNull(CodexImportMerge.resolveCodexImportRedirectSessionId(emptyList(), emptyList()))
        assertNull(
            CodexImportMerge.resolveCodexImportRedirectSessionId(
                listOf(group(canonicalSessionId = "")),
                emptyList(),
            ),
            "empty-string canonical id does not count (web Boolean() truthiness)",
        )
    }

    // ------------------------------------------------------------ normalize --

    @Test
    fun `blank messages fall back to the caller's message`() {
        assertEquals(
            "fallback",
            CodexImportMerge.normalizeCodexScriptError(null, "fallback", strings),
        )
        assertEquals(
            "fallback",
            CodexImportMerge.normalizeCodexScriptError("   ", "fallback", strings),
        )
    }

    @Test
    fun `timeout active and not-found messages classify`() {
        assertEquals(
            strings.timeout,
            CodexImportMerge.normalizeCodexScriptError("Command Timed Out", "fallback", strings),
            "timeout matches case-insensitively",
        )
        assertEquals(strings.timeout, CodexImportMerge.normalizeCodexScriptError("执行超时", "fallback", strings))
        assertEquals(
            strings.sessionActive,
            CodexImportMerge.normalizeCodexScriptError(
                "Active Hapi process already has this Codex thread",
                "fallback",
                strings,
            ),
        )
        assertEquals(
            strings.sessionActive,
            CodexImportMerge.normalizeCodexScriptError(
                "当前会话仍处于活跃状态，请等待会话结束后重试",
                "fallback",
                strings,
            ),
        )
        assertEquals(
            strings.clientNotFound,
            CodexImportMerge.normalizeCodexScriptError("Unable to find codex launcher", "fallback", strings),
        )
        assertEquals(
            strings.clientNotFound,
            CodexImportMerge.normalizeCodexScriptError("未安装/找不到codex客户端", "fallback", strings),
        )
        assertEquals(
            strings.clientNotFound,
            CodexImportMerge.normalizeCodexScriptError("找不到 codex 客户端", "fallback", strings),
            "loose 找不到.*codex variant",
        )
    }

    @Test
    fun `unknown messages pass through raw`() {
        assertEquals(
            "disk full",
            CodexImportMerge.normalizeCodexScriptError("disk full", "fallback", strings),
        )
    }

    // -------------------------------------------------------------- format --

    @Test
    fun `classified messages pass through format unchanged`() {
        assertEquals(strings.timeout, CodexImportMerge.formatCodexImportFailure(strings.timeout, strings))
        assertEquals(
            strings.sessionActive,
            CodexImportMerge.formatCodexImportFailure(strings.sessionActive, strings),
        )
        assertEquals(
            strings.clientNotFound,
            CodexImportMerge.formatCodexImportFailure(strings.clientNotFound, strings),
        )
    }

    @Test
    fun `everything else wraps into the reason format`() {
        assertEquals(
            "Import failed: disk full",
            CodexImportMerge.formatCodexImportFailure("disk full", strings),
        )
    }
}
