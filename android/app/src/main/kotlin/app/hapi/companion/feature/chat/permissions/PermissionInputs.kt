package app.hapi.companion.feature.chat.permissions

import app.hapi.protocol.wire.arrayOrNull
import app.hapi.protocol.wire.boolOrNull
import app.hapi.protocol.wire.objOrNull
import app.hapi.protocol.wire.stringOrNull
import kotlinx.serialization.json.JsonElement

/**
 * Question/option models + input parsers for the two interactive request
 * tools, ported from `web/src/components/ToolCard/askUserQuestion.ts`,
 * `cursorAskQuestion.ts` and `requestUserInput.ts`. Pure JVM — unit-tested
 * alongside the ViewModel.
 */

data class AskOption(
    /** Stable option id (Cursor ACP); falls back to the label on submit. */
    val id: String?,
    val label: String,
    val description: String?,
)

data class AskQuestion(
    /** Stable question id (Cursor ACP); falls back to the index on submit. */
    val id: String?,
    val header: String?,
    val question: String,
    val options: List<AskOption>,
    val multiSelect: Boolean,
) {
    /** The flat-answers key: stable id when present, else the index (web parity). */
    fun answerKey(index: Int, useStableIds: Boolean): String =
        if (useStableIds && !id.isNullOrBlank()) id else index.toString()
}

fun isCursorAskQuestionToolName(toolName: String): Boolean = toolName == "CursorAskQuestion"

/**
 * `parseAskUserQuestionInput` / `parseCursorAskQuestionInput` merged: the
 * Cursor dialect adds `prompt`/`title`/`allowMultiple` synonyms and stable
 * ids; both collapse to the same [AskQuestion] list.
 */
fun parseAskUserQuestions(input: JsonElement?, cursorDialect: Boolean): List<AskQuestion> {
    val root = input.objOrNull ?: return emptyList()
    val rawQuestions = root["questions"].arrayOrNull ?: return emptyList()
    val requestTitle = if (cursorDialect) root["title"].stringOrNull?.trim().orEmpty() else ""

    val questions = mutableListOf<AskQuestion>()
    for (raw in rawQuestions) {
        val obj = raw.objOrNull ?: continue

        val question = if (cursorDialect) {
            obj["prompt"].stringOrNull?.trim() ?: obj["question"].stringOrNull?.trim().orEmpty()
        } else {
            obj["question"].stringOrNull?.trim().orEmpty()
        }
        val header = if (cursorDialect) {
            obj["title"].stringOrNull?.trim() ?: obj["header"].stringOrNull?.trim().orEmpty()
        } else {
            obj["header"].stringOrNull?.trim().orEmpty()
        }
        val multiSelect = if (cursorDialect) {
            obj["allowMultiple"].boolOrNull == true || obj["multiSelect"].boolOrNull == true
        } else {
            obj["multiSelect"].boolOrNull == true
        }
        val questionId = if (cursorDialect) {
            obj["id"].stringOrNull?.trim()?.takeIf { it.isNotEmpty() } ?: questions.size.toString()
        } else {
            null
        }

        val options = mutableListOf<AskOption>()
        for (rawOption in obj["options"].arrayOrNull ?: emptyList()) {
            val optionObj = rawOption.objOrNull ?: continue
            val label = if (cursorDialect) {
                optionObj["label"].stringOrNull?.trim() ?: optionObj["id"].stringOrNull?.trim().orEmpty()
            } else {
                optionObj["label"].stringOrNull?.trim().orEmpty()
            }
            if (label.isEmpty()) continue
            val optionId = if (cursorDialect) {
                optionObj["id"].stringOrNull?.trim()?.takeIf { it.isNotEmpty() } ?: label
            } else {
                null
            }
            val description = if (cursorDialect) null else optionObj["description"].stringOrNull?.trim()
            options += AskOption(id = optionId, label = label, description = description?.takeIf { it.isNotEmpty() })
        }

        if (question.isEmpty() && options.isEmpty()) continue

        questions += AskQuestion(
            id = questionId,
            header = header.ifEmpty { requestTitle.ifEmpty { null } },
            question = question,
            options = options,
            multiSelect = multiSelect,
        )
    }
    return questions
}

data class RequestUserInputQuestion(
    val id: String,
    val question: String,
    val required: Boolean,
    val multiple: Boolean,
    val options: List<AskOption>,
    val placeholder: String?,
    val prefill: String?,
)

/** `parseRequestUserInputInput` (the URL-confirmation flow is web-only). */
fun parseRequestUserInputQuestions(input: JsonElement?): List<RequestUserInputQuestion> {
    val root = input.objOrNull ?: return emptyList()
    val rawQuestions = root["questions"].arrayOrNull ?: return emptyList()

    val questions = mutableListOf<RequestUserInputQuestion>()
    for (raw in rawQuestions) {
        val obj = raw.objOrNull ?: continue
        val id = obj["id"].stringOrNull?.trim().orEmpty()
        if (id.isEmpty()) continue

        val options = mutableListOf<AskOption>()
        for (rawOption in obj["options"].arrayOrNull ?: emptyList()) {
            val optionObj = rawOption.objOrNull ?: continue
            val label = optionObj["label"].stringOrNull?.trim().orEmpty()
            if (label.isEmpty()) continue
            options += AskOption(
                id = null,
                label = label,
                description = optionObj["description"].stringOrNull?.trim()?.takeIf { it.isNotEmpty() },
            )
        }

        questions += RequestUserInputQuestion(
            id = id,
            question = obj["question"].stringOrNull?.trim().orEmpty(),
            required = obj["required"].boolOrNull != false,
            multiple = obj["multiple"].boolOrNull == true,
            options = options,
            placeholder = obj["placeholder"].stringOrNull,
            prefill = obj["prefill"].stringOrNull,
        )
    }
    return questions
}

/**
 * `formatRequestUserInputAnswers` value building for ONE field: selected
 * option labels plus a trailing `user_note: <text>` entry when a note was
 * typed. The nested `{answers: [...]}` wrapper is applied by the ViewModel.
 */
fun requestUserInputAnswerValues(selected: List<String>, note: String): List<String> {
    val values = selected.toMutableList()
    val trimmed = note.trim()
    if (trimmed.isNotEmpty()) values += "user_note: $trimmed"
    return values
}

/** `isRequestUserInputQuestionAnswered`. */
fun isRequestUserInputAnswered(
    question: RequestUserInputQuestion,
    selected: List<String>,
    note: String,
): Boolean {
    if (!question.required) return true
    if (question.options.isNotEmpty()) return selected.isNotEmpty()
    return note.trim().isNotEmpty()
}
