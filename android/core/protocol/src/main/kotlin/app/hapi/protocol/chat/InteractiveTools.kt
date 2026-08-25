package app.hapi.protocol.chat

/**
 * Tool-name predicates ported from
 * `web/src/components/ToolCard/askUserQuestion.ts` and
 * `web/src/components/ToolCard/requestUserInput.ts` (the pipeline-relevant
 * subset — tool grouping treats these as interactive and never groups them).
 * The full question/answer parsing ports with the permission-UX milestone (M3b).
 */

fun isAskUserQuestionToolName(toolName: String): Boolean =
    toolName == "AskUserQuestion" || toolName == "ask_user_question" || toolName == "CursorAskQuestion"

fun isRequestUserInputToolName(toolName: String): Boolean =
    toolName == "request_user_input"
