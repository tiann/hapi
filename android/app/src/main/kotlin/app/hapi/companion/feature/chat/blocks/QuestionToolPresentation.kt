package app.hapi.companion.feature.chat.blocks

import app.hapi.companion.feature.chat.permissions.RequestUserInputQuestion
import app.hapi.companion.feature.chat.permissions.isCursorAskQuestionToolName
import app.hapi.companion.feature.chat.permissions.parseAskUserQuestions
import app.hapi.companion.feature.chat.permissions.parseRequestUserInputQuestions
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.isAskUserQuestionToolName
import app.hapi.protocol.chat.isRequestUserInputToolName
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.arrayOrNull
import app.hapi.protocol.wire.objOrNull
import app.hapi.protocol.wire.stringOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Read-only projection, independent of answer drafts and permission submission. */
internal data class QuestionToolDetails(val questions: List<QuestionDetail>, val showResult: Boolean) {
    val hasAnswers: Boolean get() = questions.any { it.hasAnswers }
}

internal data class QuestionDetail(
    val header: String?,
    val question: String,
    val multiple: Boolean,
    val options: List<QuestionOptionDetail>,
    val otherAnswers: List<String>,
    val note: String?,
) {
    val hasAnswers: Boolean get() = options.any { it.selected } || otherAnswers.isNotEmpty() || note != null
}

internal data class QuestionOptionDetail(val label: String, val description: String?, val selected: Boolean)

internal fun isQuestionDetailsTool(name: String): Boolean {
    val name = toolPresentationName(name)
    return isAskUserQuestionToolName(name) || isRequestUserInputToolName(name)
}

internal fun questionToolDetails(tool: ChatToolCall): QuestionToolDetails {
    val name = toolPresentationName(tool.name)
    val answers = questionAnswerMap(tool.permission?.answers)
    val questions = when {
        isAskUserQuestionToolName(name) -> {
            val cursor = isCursorAskQuestionToolName(name)
            val parsed = parseAskUserQuestions(tool.input, cursorDialect = cursor)
            if (parsed.isEmpty()) {
                // The malformed-input answer form submits free text as "0".
                val values = answers["0"].orEmpty().map(String::trim).filter(String::isNotEmpty)
                if (values.isEmpty()) emptyList() else listOf(
                    QuestionDetail(null, "", false, emptyList(), values, null),
                )
            } else parsed.mapIndexed { index, question ->
                val values = answers[question.answerKey(index, useStableIds = cursor)].orEmpty()
                    .map(String::trim).filter(String::isNotEmpty)
                val optionValues = question.options.map { if (cursor) it.id ?: it.label else it.label }
                QuestionDetail(
                    header = question.header, question = question.question, multiple = question.multiSelect,
                    options = question.options.mapIndexed { optionIndex, option ->
                        QuestionOptionDetail(option.label, option.description, optionValues[optionIndex] in values)
                    },
                    otherAnswers = values.filter { it !in optionValues }, note = null,
                )
            }
        }
        isRequestUserInputToolName(name) -> {
            val parsed = parseRequestUserInputQuestions(tool.input)
            val live = requestQuestionDetails(parsed, answers)
            // Prefer usable live answers as a whole; never merge stale history.
            if (live.any { it.hasAnswers }) live else {
                val result = tool.result?.stringOrNull?.let { runCatching { HapiJson.parseToJsonElement(it) }.getOrNull() }
                    ?: tool.result
                requestQuestionDetails(parsed, questionAnswerMap(result))
            }
        }
        else -> emptyList()
    }
    return QuestionToolDetails(questions, showResult = tool.state == "error" || questions.none { it.hasAnswers })
}

/** Documented flat/nested maps and one outer wrapper; "answers" is also a valid question id. */
private fun questionAnswerMap(value: JsonElement?): Map<String, List<String>> {
    val obj = value.objOrNull ?: return emptyMap()
    fun parse(obj: JsonObject): Map<String, List<String>> = obj.mapNotNull { (key, value) ->
        val array = value.arrayOrNull ?: value.objOrNull?.get("answers").arrayOrNull ?: return@mapNotNull null
        key to array.mapNotNull { it.stringOrNull }
    }.toMap()
    val direct = parse(obj)
    if (direct.isNotEmpty()) return direct
    return obj["answers"].objOrNull?.let(::parse).orEmpty()
}

private fun requestQuestionDetails(
    questions: List<RequestUserInputQuestion>, answers: Map<String, List<String>>,
): List<QuestionDetail> = questions.map { question ->
    val selected = mutableSetOf<String>()
    val other = mutableListOf<String>()
    var note: String? = null
    for (value in answers[question.id].orEmpty()) {
        val trimmed = value.trim()
        val option = question.options.firstOrNull { it.label == trimmed }
        when {
            // An actual option named "user_note: ..." is not metadata.
            option != null -> selected += option.label
            value.startsWith("user_note: ") -> {
                val text = value.removePrefix("user_note: ")
                if (question.inputType == "editor") note = text // Empty documents are answers, too.
                else text.trim().takeIf(String::isNotEmpty)?.let { note = it }
            }
            trimmed.isNotEmpty() -> other += trimmed // Codex history can contain plain free text.
        }
    }
    QuestionDetail(
        header = null, question = question.question, multiple = question.multiple,
        options = question.options.map { QuestionOptionDetail(it.label, it.description, it.label in selected) },
        otherAnswers = other, note = note,
    )
}
