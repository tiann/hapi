import XCTest
@testable import Hapi
@testable import HapiProtocol

final class ToolContentPresentationTests: XCTestCase {
    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    private func tool(_ name: String = "Bash", input: JSONValue? = nil, result: JSONValue? = nil,
                      state: ToolCallState = .completed) -> ChatToolCall {
        ChatToolCall(id: "tool", name: name, state: state, input: input, createdAt: 0, result: result)
    }

    func testAliasesAndFreeformInputsDoNotRewriteRecordedCalls() throws {
        let call = tool("functions.exec_command", input: try json(#"{"cmd":"printf 'hello\\n'","workdir":"/workspace"}"#))
        XCTAssertEqual(toolPresentationName(call.name), "Bash")
        XCTAssertEqual(call.name, "functions.exec_command")
        XCTAssertEqual(chatTerminalCommand(call.input), "printf 'hello\\n'")
        XCTAssertEqual(toolPresentationName("functions.apply_patch"), "CodexPatch")
        XCTAssertEqual(toolPresentationName("mcp__server__exec_command"), "mcp__server__exec_command")
        let source = "text(await tools.exec_command({cmd: 'pwd'}));\n"
        XCTAssertEqual(toolSourceInput(.string(source), keys: ["code"]), source)
        XCTAssertEqual(toolSourceInput(.object(["patch": .string("*** Begin Patch\n")]), keys: ["patch"]), "*** Begin Patch\n")
        XCTAssertNil(toolSourceInput(.object(["unknown": .bool(true)]), keys: ["patch"]))
    }

    func testPlanProposalsReadInputAndPreserveTheCompleteDocument() throws {
        let plan = "\n# 计划 👩🏽‍💻\n\n" + String(repeating: "- Inspect **input.plan**  \n", count: 1_000) + "last  \n"
        for name in ["ExitPlanMode", "exit_plan_mode"] {
            let input: JSONValue = .object(["plan": .string(plan), "extra": .bool(true)])
            let call = tool(name, input: input, result: .null)
            XCTAssertTrue(isPlanProposalTool(name))
            XCTAssertEqual(planProposalMarkdown(call), plan)
            XCTAssertEqual(call.input, input)
            XCTAssertFalse(planProposalShowsResult(call))
            for result in [JSONValue.string("Approved"), .object(["error": .string("Failed")])] {
                XCTAssertTrue(planProposalShowsResult(tool(name, input: input, result: result)))
            }
            for result in [nil, JSONValue.null, .string(" \n")] {
                XCTAssertFalse(planProposalShowsResult(tool(name, input: input, result: result)))
            }
            XCTAssertTrue(planProposalShowsResult(tool(name, input: input, state: .error)))
            for input in ["null", "[]", "{}", #"{"plan":null}"#, #"{"plan":42}"#,
                          #"{"plan":[]}"#, #"{"plan":"  \n"}"#, #""a raw string""#] {
                XCTAssertNil(planProposalMarkdown(tool(name, input: try json(input))), input)
            }
        }
        XCTAssertNil(planProposalMarkdown(tool("update_plan", input: .object(["plan": .string(plan)]))))
        XCTAssertNil(planProposalMarkdown(tool("mcp__server__ExitPlanMode", input: .object(["plan": .string(plan)]))))
        XCTAssertEqual(checklistItems(try json(#"{"plan":[{"step":"Inspect","status":"completed"}]}"#)).first?.glyph, "☑")
    }

    func testResultEnvelopesAndWhitespace() throws {
        for payload in [#"{"output":"hello\n"}"#, #"{"result":{"data":{"text":"hello\n"}}}"#,
                        #"{"content":["hello\n"]}"#, #"{"file":{"content":"hello\n"}}"#,
                        #"{"output":{"stdout":"hello\n","stderr":""}}"#] {
            XCTAssertEqual(extractResultText(try json(payload)), "hello\n", payload)
        }
        XCTAssertEqual(extractResultText(try json(#"{"stdout":"  out  \n","stderr":" err \n"}"#)), "  out  \n\n\nstderr:\n err \n")
        XCTAssertEqual(extractResultText(try json(#"{"stdout":"","error":{"message":"failed"}}"#)), "failed")
        XCTAssertEqual(extractResultText(try json(#"{"content":""}"#)), "")
    }

    func testMixedContentAndUnknownResultsStayAccessibleAsJSON() throws {
        let mixed = try json(#"{"content":[{"type":"text","text":"caption"},{"type":"image","data":"abc"}],"text":"do not drop image"}"#)
        XCTAssertNil(extractResultText(mixed))
        guard case .json(let text) = resultRendering(tool(result: mixed)) else { return XCTFail("Expected JSON fallback") }
        XCTAssertEqual(try json(text), mixed)
        XCTAssertNil(extractResultText(try json(#"{"data":{"result":{"data":{"result":{"data":{"text":"too deep"}}}}}}"#)))
        XCTAssertNil(extractResultText(.number(42)))
    }

    func testFileAndMarkdownResultsUseSemanticRenderersButErrorsStayLiteral() throws {
        let input = try json(#"{"file_path":"/workspace/main.ts"}"#)
        let result = try json(#"{"file":{"filePath":"main.swift","content":"let x = 1\n"}}"#)
        guard case .code(let text, let language) = resultRendering(tool("functions.Read", input: input, result: result)) else {
            return XCTFail("File reads should render source, not JSON/terminal")
        }
        XCTAssertEqual(text, "let x = 1\n")
        XCTAssertEqual(language, "swift")
        let parsed = try json(#"{"parsed_cmd":[{"type":"read","name":"main.kt"}]}"#)
        XCTAssertEqual(toolResultStyle(tool("CodexBash", input: parsed)), .code("kotlin"))
        XCTAssertEqual(toolResultStyle(tool("WebFetch")), .markdown)
        XCTAssertEqual(toolResultStyle(tool("WebFetch", state: .error)), .terminal)
        XCTAssertEqual(toolResultStyle(tool("Read", input: input, state: .error)), .terminal)
    }

    func testLargeResultsAreNotTruncatedOrEagerlyParsed() {
        let diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n"
        guard case .diffs = resultRendering(tool(result: .string(diff))) else { return XCTFail("Small diff") }
        let text = diff + String(repeating: " context 中👩🏽‍💻\n", count: 10_000) + "last  \n"
        guard case .terminal(let actual) = resultRendering(tool(result: .string(text))) else { return XCTFail("Paged source") }
        XCTAssertEqual(actual, text)
        guard case .code(let actual, let language) = resultRendering(tool("WebFetch", result: .string(text))) else { return XCTFail("Paged markdown source") }
        XCTAssertEqual(actual, text)
        XCTAssertEqual(language, "markdown")
        XCTAssertNil(resultRendering(tool(result: .null)))
    }

    func testCommandMetadataSurvivesEmptyOutputAndNestedWrappers() throws {
        let result = try json(#"{"output":{"stdout":"","exitCode":1,"status":"failed","session_id":42}}"#)
        XCTAssertEqual(extractResultText(result), "")
        XCTAssertEqual(toolResultMetadata(result), ["exit_code: 1", "status: failed", "session_id: 42"])
        XCTAssertEqual(toolResultMetadata(try json(#"{"exit_code":null,"status":{"text":"not metadata"}}"#)), [])
    }

    func testOptionDescriptionsAndLanguageInference() throws {
        XCTAssertEqual(toolQuestionOptionText(try json(#"{"label":"Fast","description":"Less detail"}"#)), "Fast — Less detail")
        XCTAssertEqual(toolQuestionOptionText(.string("Yes")), "Yes")
        XCTAssertEqual(toolQuestionOptionText(.number(1)), "1")
        XCTAssertEqual(languageForPath("C:\\work\\main.MTS"), "typescript")
        XCTAssertEqual(languageForPath("/work/Dockerfile"), "dockerfile")
        XCTAssertNil(languageForPath("/work.ts/README"))
    }
}
