package app.hapi.companion.feature.chat.blocks

import app.hapi.companion.feature.chat.terminalCommand
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.wire.HapiJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ToolContentPresentationTest {
    private fun json(text: String) = HapiJson.parseToJsonElement(text)
    private fun tool(name: String = "Bash", input: JsonElement? = null, result: JsonElement? = null, state: String = "completed") =
        ChatToolCall(id = "tool", name = name, state = state, input = input, createdAt = 0, description = null, result = result)

    @Test fun aliasesAndFreeformInputsDoNotRewriteRecordedCalls() {
        val call = tool("functions.exec_command", input = json("""{"cmd":"printf 'hello\\n'","workdir":"/workspace"}"""))
        assertEquals("Bash", toolPresentationName(call.name))
        assertEquals("functions.exec_command", call.name)
        assertEquals("printf 'hello\\n'", terminalCommand(call.input))
        assertEquals("CodexPatch", toolPresentationName("functions.apply_patch"))
        assertEquals("mcp__server__exec_command", toolPresentationName("mcp__server__exec_command"))
        val source = "text(await tools.exec_command({cmd: 'pwd'}));\n"
        assertEquals(source, toolSourceInput(JsonPrimitive(source), listOf("code")))
        assertEquals("*** Begin Patch\n", toolSourceInput(json("""{"patch":"*** Begin Patch\n"}"""), listOf("patch")))
        assertNull(toolSourceInput(json("""{"unknown":true}"""), listOf("patch")))
    }

    @Test fun planProposalsReadInputAndPreserveTheCompleteDocument() {
        val plan = "\n# 计划 👩🏽‍💻\n\n" + "- Inspect **input.plan**  \n".repeat(1_000) + "last  \n"
        for (name in listOf("ExitPlanMode", "exit_plan_mode")) {
            val input = JsonObject(mapOf("plan" to JsonPrimitive(plan), "extra" to JsonPrimitive(true)))
            val call = tool(name, input, JsonNull)
            assertTrue(isPlanProposalTool(name))
            assertEquals(plan, planProposalMarkdown(call))
            assertEquals(input, call.input)
            assertFalse(planProposalShowsResult(call))
            for (result in listOf(JsonPrimitive("Approved"), json("""{"error":"Failed"}"""))) {
                assertTrue(planProposalShowsResult(tool(name, input, result)))
            }
            for (result in listOf(null, JsonNull, JsonPrimitive(" \n"))) {
                assertFalse(planProposalShowsResult(tool(name, input, result)))
            }
            assertTrue(planProposalShowsResult(tool(name, input, state = "error")))
            for (value in listOf("null", "[]", "{}", """{"plan":null}""", """{"plan":42}""",
                """{"plan":[]}""", """{"plan":"  \n"}""", """"a raw string"""")) {
                assertNull(planProposalMarkdown(tool(name, json(value))), value)
            }
        }
        val input = JsonObject(mapOf("plan" to JsonPrimitive(plan)))
        assertNull(planProposalMarkdown(tool("update_plan", input)))
        assertNull(planProposalMarkdown(tool("mcp__server__ExitPlanMode", input)))
        assertNull(planProposalMarkdown(tool("update_plan", json("""{"plan":[{"step":"Inspect","status":"completed"}]}"""))))
    }

    @Test fun resultEnvelopesAndWhitespace() {
        for (payload in listOf("""{"output":"hello\n"}""", """{"result":{"data":{"text":"hello\n"}}}""",
            """{"content":["hello\n"]}""", """{"file":{"content":"hello\n"}}""",
            """{"output":{"stdout":"hello\n","stderr":""}}""")) {
            assertEquals("hello\n", extractResultText(json(payload)), payload)
        }
        assertEquals("  out  \n\n\nstderr:\n err \n", extractResultText(json("""{"stdout":"  out  \n","stderr":" err \n"}""")))
        assertEquals("failed", extractResultText(json("""{"stdout":"","error":{"message":"failed"}}""")))
        assertEquals("", extractResultText(json("""{"content":""}""")))
    }

    @Test fun mixedContentAndUnknownResultsStayAccessibleAsJson() {
        val mixed = json("""{"content":[{"type":"text","text":"caption"},{"type":"image","data":"abc"}],"text":"do not drop image"}""")
        assertNull(extractResultText(mixed))
        assertEquals(mixed, json(assertIs<ResultRendering.Json>(resultRendering(tool(result = mixed))).pretty))
        assertNull(extractResultText(json("""{"data":{"result":{"data":{"result":{"data":{"text":"too deep"}}}}}}""")))
        assertNull(extractResultText(JsonPrimitive(42)))
    }

    @Test fun fileAndMarkdownResultsUseSemanticRenderersButErrorsStayLiteral() {
        val input = json("""{"file_path":"/workspace/main.ts"}""")
        val result = json("""{"file":{"filePath":"main.swift","content":"let x = 1\n"}}""")
        val rendered = assertIs<ResultRendering.Code>(resultRendering(tool("functions.Read", input, result)))
        assertEquals("let x = 1\n", rendered.text)
        assertEquals("swift", rendered.language)
        val parsed = json("""{"parsed_cmd":[{"type":"read","name":"main.kt"}]}""")
        assertEquals(ToolResultStyle.Code("kotlin"), toolResultStyle(tool("CodexBash", input = parsed)))
        assertEquals(ToolResultStyle.Markdown, toolResultStyle(tool("WebFetch")))
        assertEquals(ToolResultStyle.Terminal, toolResultStyle(tool("WebFetch", state = "error")))
        assertEquals(ToolResultStyle.Terminal, toolResultStyle(tool("Read", input = input, state = "error")))
    }

    @Test fun largeResultsAreNotTruncatedOrEagerlyParsed() {
        val diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n"
        assertIs<ResultRendering.Diffs>(resultRendering(tool(result = JsonPrimitive(diff))))
        val text = diff + " context 中👩🏽‍💻\n".repeat(10_000) + "last  \n"
        assertEquals(text, assertIs<ResultRendering.Terminal>(resultRendering(tool(result = JsonPrimitive(text)))).text)
        val markdown = assertIs<ResultRendering.Code>(resultRendering(tool("WebFetch", result = JsonPrimitive(text))))
        assertEquals(text, markdown.text)
        assertEquals("markdown", markdown.language)
        assertNull(resultRendering(tool(result = JsonNull)))
    }

    @Test fun pagesPreserveUnicodeAndTheEntirePayload() {
        val text = "x".repeat(TOOL_TEXT_PAGE_SIZE - 1) + "👩🏽‍💻中\n".repeat(20_000) + "last  \n"
        val pages = toolTextPages(text)
        assertTrue(pages.size > 1)
        assertEquals(text, pages.joinToString(""))
        assertTrue(pages.all { it.length <= TOOL_TEXT_PAGE_SIZE && !Character.isHighSurrogate(it.last()) && !Character.isLowSurrogate(it.first()) })
        assertEquals(emptyList(), toolTextPages(""))
        assertEquals(listOf("hello\n"), toolTextPages("hello\n"))
    }

    @Test fun commandMetadataSurvivesEmptyOutputAndNestedWrappers() {
        val result = json("""{"output":{"stdout":"","exitCode":1,"status":"failed","session_id":42}}""")
        assertEquals("", extractResultText(result))
        assertEquals(listOf("exit_code: 1", "status: failed", "session_id: 42"), toolResultMetadata(result))
        assertEquals(emptyList(), toolResultMetadata(json("""{"exit_code":null,"status":{"text":"not metadata"}}""")))
    }

    @Test fun optionDescriptionsAndLanguageInference() {
        assertEquals("Fast — Less detail", toolQuestionOptionText(json("""{"label":"Fast","description":"Less detail"}""")))
        assertEquals("Yes", toolQuestionOptionText(JsonPrimitive("Yes")))
        assertEquals("1", toolQuestionOptionText(JsonPrimitive(1)))
        assertEquals("typescript", languageForPath("C:\\work\\main.MTS"))
        assertEquals("dockerfile", languageForPath("/work/Dockerfile"))
        assertNull(languageForPath("/work.ts/README"))
    }
}
