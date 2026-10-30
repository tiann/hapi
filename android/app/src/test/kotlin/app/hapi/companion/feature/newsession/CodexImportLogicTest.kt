package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.CodexDesktopSyncRequest
import app.hapi.protocol.wire.CodexLocalSessionSummary
import app.hapi.protocol.wire.HapiJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive

/**
 * Pins the pure codex-import helpers against the web semantics
 * (`web/src/components/CodexSessionSyncDialog.tsx` + the codex-import
 * branch of web `handleCreate`).
 */
class CodexImportLogicTest {

    private fun session(
        id: String,
        title: String = "Session $id",
        cwd: String? = null,
        lastUserMessage: String? = null,
        originator: String? = null,
        cliVersion: String? = null,
        threadSource: String? = null,
        forkedFromId: String? = null,
    ): CodexLocalSessionSummary = CodexLocalSessionSummary(
        id = id,
        title = title,
        lastUserMessage = lastUserMessage,
        cwd = cwd,
        file = "/rollout/$id.json",
        modifiedAt = 1_700_000_000_000,
        originator = originator,
        cliVersion = cliVersion,
        threadSource = threadSource,
        forkedFromId = forkedFromId,
    )

    // ------------------------------------------------------- workdir filter --

    @Test
    fun `workdir options dedupe trimmed cwds and sort them`() {
        val sessions = listOf(
            session("b", cwd = " /beta "),
            session("a", cwd = "/alpha"),
            session("a2", cwd = "/alpha"),
            session("blank", cwd = "   "),
            session("none"),
        )
        assertEquals(listOf("/alpha", "/beta"), CodexImportLogic.workdirOptions(sessions))
        assertEquals(emptyList(), CodexImportLogic.workdirOptions(emptyList()))
    }

    @Test
    fun `default workdir filter picks the current directory only when listed`() {
        val sessions = listOf(session("a", cwd = "/alpha"), session("b", cwd = "/beta"))
        assertEquals("/alpha", CodexImportLogic.defaultWorkdirFilter(sessions, " /alpha "))
        assertEquals(CodexImportLogic.ALL_WORKDIR_FILTER, CodexImportLogic.defaultWorkdirFilter(sessions, "/gamma"))
        assertEquals(CodexImportLogic.ALL_WORKDIR_FILTER, CodexImportLogic.defaultWorkdirFilter(sessions, "   "))
        assertEquals(CodexImportLogic.ALL_WORKDIR_FILTER, CodexImportLogic.defaultWorkdirFilter(emptyList(), "/alpha"))
    }

    // ----------------------------------------------------------- filtering --

    @Test
    fun `filtering narrows by workdir and search together`() {
        val sessions = listOf(
            session("alpha-fix", title = "Fix bug", cwd = "/alpha", lastUserMessage = "please fix"),
            session("alpha-docs", title = "Docs pass", cwd = "/alpha"),
            session("beta-fix", title = "Fix flake", cwd = "/beta"),
        )
        assertEquals(
            listOf("alpha-fix", "alpha-docs"),
            CodexImportLogic.filterSessions(sessions, "/alpha", "").map { it.id },
        )
        assertEquals(
            listOf("alpha-fix", "beta-fix"),
            CodexImportLogic.filterSessions(sessions, CodexImportLogic.ALL_WORKDIR_FILTER, "fix").map { it.id },
        )
        assertEquals(
            listOf("alpha-fix"),
            CodexImportLogic.filterSessions(sessions, "/alpha", "fix").map { it.id },
        )
        assertEquals(3, CodexImportLogic.filterSessions(sessions, CodexImportLogic.ALL_WORKDIR_FILTER, "").size)
    }

    @Test
    fun `search covers every web field case-insensitively`() {
        val base = session(
            "sess-42",
            title = "Refactor",
            lastUserMessage = "UNBREAK the BUILD",
            cwd = "/data/Work",
            originator = "codex_vscode",
            cliVersion = "0.9.4",
        )
        assertTrue(CodexImportLogic.matchesQuery(base, "refactor")) // title
        assertTrue(CodexImportLogic.matchesQuery(base, "  unbreak ")) // trimmed + case
        assertTrue(CodexImportLogic.matchesQuery(base, "/data/work")) // cwd
        assertTrue(CodexImportLogic.matchesQuery(base, "vscode")) // originator
        assertTrue(CodexImportLogic.matchesQuery(base, "0.9.4")) // cli version
        assertTrue(CodexImportLogic.matchesQuery(base, "sess-42")) // id (substring)
        assertFalse(CodexImportLogic.matchesQuery(base, "gamma"))
        assertTrue(CodexImportLogic.matchesQuery(base, "   ")) // blank query passes
    }

    // -------------------------------------------------------------- badges --

    @Test
    fun `original and fork badges follow threadSource and forkedFromId`() {
        assertTrue(CodexImportLogic.isOriginal(session("a"))) // no fork parent
        assertTrue(CodexImportLogic.isOriginal(session("b", threadSource = "user", forkedFromId = "other")))
        assertFalse(CodexImportLogic.isOriginal(session("c", threadSource = "subagent", forkedFromId = "other")))
        assertTrue(CodexImportLogic.isForked(session("d", forkedFromId = "parent")))
        assertFalse(CodexImportLogic.isForked(session("e", forkedFromId = "  "))) // blank
        assertFalse(CodexImportLogic.isForked(session("f")))
    }

    @Test
    fun `preview prefers the trimmed last message then originator and version`() {
        assertEquals("hi there", CodexImportLogic.previewOf(session("a", lastUserMessage = "  hi there  ")))
        assertEquals("", CodexImportLogic.previewOf(session("b", lastUserMessage = "   "))) // whitespace-only falls back
        assertEquals(
            "codex_vscode · 0.9.4",
            CodexImportLogic.previewOf(session("c", originator = "codex_vscode", cliVersion = "0.9.4")),
        )
        assertEquals("codex_vscode", CodexImportLogic.previewOf(session("d", originator = "codex_vscode")))
        assertEquals("0.9.4", CodexImportLogic.previewOf(session("e", cliVersion = "0.9.4")))
        assertEquals("", CodexImportLogic.previewOf(session("f")))
    }

    // ------------------------------------------------- bulk-import trimming --

    @Test
    fun `bulk import clears the inline selection only when inside the batch`() {
        assertNull(CodexImportLogic.clearBatchImportedCodexSelection("a", listOf("a", "b")))
        assertEquals("c", CodexImportLogic.clearBatchImportedCodexSelection("c", listOf("a", "b")))
        assertNull(CodexImportLogic.clearBatchImportedCodexSelection(null, listOf("a")))
    }

    // ------------------------------------------------------ request payload --

    @Test
    fun `single import request carries exactly the web fields`() {
        val form = NewSessionForm(
            agent = "codex",
            directory = "  /form/dir  ",
            model = "gpt-5.2-codex",
            modelReasoningEffort = "high",
            serviceTier = "fast",
            collaborationMode = "review",
            permissionMode = "yolo",
        )
        val selected = session("thread-1", cwd = " /raw/cwd ")
        val request = CodexImportLogic.buildSingleImportRequest(
            form = form,
            selected = selected,
            formMachineId = "m-form",
            importMachineId = "m-import",
            codexFastTierVisible = true,
        )
        val body = HapiJson.encodeToJsonElement(CodexDesktopSyncRequest.serializer(), request) as JsonObject
        assertEquals(
            setOf(
                "sessionIds", "cwd", "machineId", "model", "modelReasoningEffort",
                "serviceTier", "collaborationMode", "yolo",
            ),
            body.keys,
        )
        assertEquals("thread-1", (body["sessionIds"] as JsonArray).single().jsonPrimitive.content)
        assertEquals(" /raw/cwd ", body["cwd"]!!.jsonPrimitive.content, "raw session cwd, no trim")
        assertEquals("m-import", body["machineId"]!!.jsonPrimitive.content, "import machine wins")
        assertEquals("gpt-5.2-codex", body["model"]!!.jsonPrimitive.content)
        assertEquals("high", body["modelReasoningEffort"]!!.jsonPrimitive.content)
        assertEquals("fast", body["serviceTier"]!!.jsonPrimitive.content)
        assertEquals("review", body["collaborationMode"]!!.jsonPrimitive.content)
        assertTrue(body["yolo"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `single import request falls back to defaults and omits neutral fields`() {
        val form = NewSessionForm(agent = "codex", directory = "/form/dir") // model auto, tier standard, mode default
        val request = CodexImportLogic.buildSingleImportRequest(
            form = form,
            selected = session("thread-1", cwd = null),
            formMachineId = "m-form",
            importMachineId = null,
            codexFastTierVisible = false,
        )
        val body = HapiJson.encodeToJsonElement(CodexDesktopSyncRequest.serializer(), request) as JsonObject
        assertEquals(setOf("sessionIds", "cwd", "machineId", "collaborationMode", "yolo"), body.keys)
        assertEquals("/form/dir", body["cwd"]!!.jsonPrimitive.content, "trimmed form directory fallback")
        assertEquals("m-form", body["machineId"]!!.jsonPrimitive.content)
        assertEquals("default", body["collaborationMode"]!!.jsonPrimitive.content, "always sent")
        assertFalse(body["yolo"]!!.jsonPrimitive.boolean, "yolo always sent, false when mode differs")
    }

    @Test
    fun `service tier rides the fast tier visibility only`() {
        val form = NewSessionForm(agent = "codex", directory = "/d", serviceTier = "fast")
        val hidden = CodexImportLogic.buildSingleImportRequest(
            form, session("t"), "m", null, codexFastTierVisible = false,
        )
        val visible = CodexImportLogic.buildSingleImportRequest(
            form, session("t"), "m", null, codexFastTierVisible = true,
        )
        val hiddenBody = HapiJson.encodeToJsonElement(CodexDesktopSyncRequest.serializer(), hidden) as JsonObject
        val visibleBody = HapiJson.encodeToJsonElement(CodexDesktopSyncRequest.serializer(), visible) as JsonObject
        assertTrue("serviceTier" !in hiddenBody.keys)
        assertEquals("fast", visibleBody["serviceTier"]!!.jsonPrimitive.content)
    }
}
