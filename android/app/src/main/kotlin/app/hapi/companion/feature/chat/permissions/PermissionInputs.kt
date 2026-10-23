package app.hapi.companion.feature.chat.permissions

import app.hapi.protocol.wire.arrayOrNull
import app.hapi.protocol.wire.boolOrNull
import app.hapi.protocol.wire.objOrNull
import app.hapi.protocol.wire.stringOrNull
import java.net.URI
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

/** Codex wire value; UI translations must never replace it in answers. */
const val REQUEST_USER_INPUT_OTHER = "None of the above"

/**
 * Id of the CLI-synthesized URL-confirmation question (Codex elicitation
 * `mode: 'url'`, `appServerPermissionAdapter.ts`): a single option whose
 * `description` carries the URL, so selecting it double-functions as the
 * "open this page" consent. Wire value, never localized.
 */
const val REQUEST_USER_INPUT_URL_CONFIRMATION_ID = "__mcp_url_confirmation"

/**
 * `parseRequestUserInputInput` result: the question list plus the sign-in
 * [url] (web `ParsedRequestUserInput`).
 */
data class RequestUserInputParsed(
    val questions: List<RequestUserInputQuestion>,
    /** `http`/`https` only; null when absent or invalid — never opened otherwise. */
    val url: String?,
)

data class RequestUserInputQuestion(
    val id: String,
    val question: String,
    val required: Boolean,
    val multiple: Boolean,
    val options: List<AskOption>,
    val placeholder: String?,
    val prefill: String?,
    val inputType: String? = null,
    val isOther: Boolean = false,
) {
    val answerOptions: List<AskOption>
        get() = if (isOther && options.isNotEmpty()) {
            options + AskOption(id = null, label = REQUEST_USER_INPUT_OTHER, description = null)
        } else options

    fun isOtherOption(index: Int): Boolean = isOther && options.isNotEmpty() && index == options.size
}

fun selectRequestUserInputOption(question: RequestUserInputQuestion, selected: Set<String>, index: Int): Set<String> {
    val option = question.answerOptions.getOrNull(index) ?: return selected
    if (question.isOtherOption(index) || !question.multiple) return setOf(option.label)
    val current = if (question.isOther) selected - REQUEST_USER_INPUT_OTHER else selected
    return if (option.label in current) current - option.label else current + option.label
}

/**
 * Web `parseRequestUserInputInput`: questions plus the validated sign-in url.
 * The url survives only when it parses AND is `http`/`https` — anything else
 * must never be opened by the approval UI.
 *
 * Divergence note: web re-normalizes via `new URL(raw).toString()`; the CLI
 * synthesizes the confirmation option's `description` from that same
 * normalized value, so comparing the raw wire string here is equivalent for
 * every CLI-produced request.
 */
fun parseRequestUserInput(input: JsonElement?): RequestUserInputParsed {
    val url = input.objOrNull?.get("url").stringOrNull?.let(::normalizeRequestUserInputUrl)
    return RequestUserInputParsed(
        questions = parseRequestUserInputQuestions(input),
        url = url,
    )
}

/** `parseRequestUserInputInput` url branch: http/https or null. */
fun normalizeRequestUserInputUrl(raw: String): String? {
    val uri = runCatching { URI(raw) }.getOrNull() ?: return null
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme != "http" && scheme != "https") return null
    // Absolute check mirrors `new URL()`: relative refs never carry a usable origin.
    if (!uri.isAbsolute) return null
    return raw
}

/**
 * `isRequestUserInputUrlConfirmed`: true iff the `__mcp_url_confirmation`
 * question exists and one of its SELECTED options has `description === url`.
 * Answers for other questions are irrelevant.
 */
fun isRequestUserInputUrlConfirmed(
    parsed: RequestUserInputParsed,
    selectedByQuestion: Map<String, List<String>>,
): Boolean {
    val url = parsed.url ?: return false
    return parsed.questions.any { question ->
        question.id == REQUEST_USER_INPUT_URL_CONFIRMATION_ID &&
            question.options.any { option ->
                option.label in (selectedByQuestion[question.id] ?: emptyList()) &&
                    option.description == url
            }
    }
}

/** `parseRequestUserInputInput` question branch (list-only). */
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
            inputType = obj["inputType"].stringOrNull?.takeIf { it == "editor" },
            isOther = obj["isOther"].boolOrNull == true,
        )
    }
    return questions
}

/**
 * `formatRequestUserInputAnswers` value building for ONE field: selected
 * option labels plus a trailing `user_note: <text>` entry. Editor inputs keep
 * the note verbatim and always push the entry (even empty — the editor's
 * output is a formatted artifact in its own right); everything else is
 * trimmed and only pushed when non-empty. The nested `{answers: [...]}`
 * wrapper is applied by the ViewModel.
 */
fun requestUserInputAnswerValues(
    question: RequestUserInputQuestion,
    selected: List<String>,
    note: String,
): List<String> {
    val values = selected.toMutableList()
    val isEditor = question.inputType == "editor"
    val effectiveNote = if (isEditor) note else note.trim()
    if (isEditor || effectiveNote.isNotEmpty()) values += "user_note: $effectiveNote"
    return values
}

/**
 * `isRequestUserInputQuestionAnswered`: required option questions need a
 * selection; required plain-text questions need a non-blank note UNLESS the
 * answer is produced by an external editor (`inputType: 'editor'`), which is
 * always considered answered.
 */
fun isRequestUserInputAnswered(
    question: RequestUserInputQuestion,
    selected: List<String>,
    note: String,
): Boolean {
    if (!question.required) return true
    if (question.options.isNotEmpty()) return selected.isNotEmpty()
    if (question.inputType == "editor") return true
    return note.trim().isNotEmpty()
}
