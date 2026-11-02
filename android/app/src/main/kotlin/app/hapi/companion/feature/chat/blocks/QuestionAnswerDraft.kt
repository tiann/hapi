package app.hapi.companion.feature.chat.blocks

import androidx.compose.runtime.saveable.Saver
import app.hapi.companion.feature.chat.PermissionAction
import app.hapi.companion.feature.chat.PermissionRowOverride
import app.hapi.companion.feature.chat.permissions.AskOption
import app.hapi.companion.feature.chat.permissions.AskQuestion
import app.hapi.companion.feature.chat.permissions.RequestUserInputQuestion
import app.hapi.companion.feature.chat.permissions.isCursorAskQuestionToolName
import app.hapi.companion.feature.chat.permissions.isRequestUserInputAnswered
import app.hapi.companion.feature.chat.permissions.isRequestUserInputUrlConfirmed
import app.hapi.companion.feature.chat.permissions.parseAskUserQuestions
import app.hapi.companion.feature.chat.permissions.parseRequestUserInput
import app.hapi.companion.feature.chat.permissions.requestUserInputAnswerValues
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.ToolState
import app.hapi.protocol.chat.isRequestUserInputToolName

/**
 * Presentation adapter only (iOS `QuestionAnswerForm` twin). The existing
 * parsers and dialect-specific wire values stay authoritative; display labels
 * must never become answer values.
 */
internal class QuestionAnswerForm(tool: ChatToolCall) {
    sealed interface Field {
        val key: String
        val header: String?
        val question: String
        val options: List<AskOption>
        val multiple: Boolean
        val required: Boolean
        val allowsCustomAnswer: Boolean
        val prefill: String
        val placeholder: String?

        fun isOtherOption(index: Int): Boolean = false
        fun values(selected: Set<Int>, text: String): List<String>
        fun isAnswered(selected: Set<Int>, text: String): Boolean

        data class Ask(val ask: AskQuestion, override val key: String, val stableOptionIds: Boolean) : Field {
            override val header get() = ask.header
            override val question get() = ask.question
            override val options get() = ask.options
            override val multiple get() = ask.multiSelect
            override val required get() = true
            override val allowsCustomAnswer get() = true
            override val prefill get() = ""
            override val placeholder: String? get() = null

            override fun values(selected: Set<Int>, text: String): List<String> {
                val picked = options.indices.filter { it in selected }.map { index ->
                    val option = options[index]
                    if (stableOptionIds) option.id ?: option.label else option.label
                }
                val custom = text.trim()
                return if (custom.isEmpty()) picked else picked + custom
            }

            override fun isAnswered(selected: Set<Int>, text: String) = values(selected, text).isNotEmpty()
        }

        data class Request(val request: RequestUserInputQuestion) : Field {
            override val key get() = request.id
            override val header: String? get() = null
            override val question get() = request.question
            override val options get() = request.answerOptions
            override val multiple get() = request.multiple
            override val required get() = request.required
            override val allowsCustomAnswer get() = false
            override val prefill get() = request.prefill.orEmpty()
            override val placeholder get() = request.placeholder

            override fun isOtherOption(index: Int) = request.isOtherOption(index)

            private fun labels(selected: Set<Int>) = options.indices.filter { it in selected }.map { options[it].label }

            override fun values(selected: Set<Int>, text: String) =
                requestUserInputAnswerValues(request, labels(selected), text)

            override fun isAnswered(selected: Set<Int>, text: String) =
                isRequestUserInputAnswered(request, labels(selected), text)
        }
    }

    val fields: List<Field>
    val nestedAnswers: Boolean

    /** Validated sign-in URL (request_user_input only); opened on submit after explicit confirmation. */
    val url: String?
    private val requestParsed = if (isRequestUserInputToolName(toolPresentationName(tool.name))) {
        parseRequestUserInput(tool.input)
    } else null

    init {
        val name = toolPresentationName(tool.name)
        nestedAnswers = requestParsed != null
        url = requestParsed?.url
        fields = if (requestParsed != null) {
            // One answer slot per stable id; malformed duplicates must not
            // create two steps that silently overwrite one another on submit.
            val seen = mutableSetOf<String>()
            requestParsed.questions.filter { seen.add(it.id) }.map(Field::Request)
        } else {
            val cursor = isCursorAskQuestionToolName(name)
            val parsed = parseAskUserQuestions(tool.input, cursor)
                .ifEmpty { listOf(AskQuestion(null, null, "", emptyList(), false)) }
            val seen = mutableSetOf<String>()
            parsed.mapIndexedNotNull { index, question ->
                val key = question.answerKey(index, cursor)
                if (seen.add(key)) Field.Ask(question, key, cursor) else null
            }
        }
    }

    /** Sign-in requests submit only after the URL-confirmation option is selected. */
    fun isUrlConfirmed(draft: QuestionAnswerDraft): Boolean {
        val parsed = requestParsed ?: return true
        if (parsed.url == null) return true
        val selected = fields.mapIndexed { index, field ->
            field.key to field.options.indices.filter { it in draft.selected(index) }.map { field.options[it].label }
        }.toMap()
        return isRequestUserInputUrlConfirmed(parsed, selected)
    }
}

/**
 * One request-owned value (iOS `QuestionAnswerDraft` twin). Only explicit
 * user actions navigate; re-rendering or restoring a draft cannot.
 */
internal data class QuestionAnswerDraft(
    val page: Int = 0,
    val selections: Map<Int, Set<Int>> = emptyMap(),
    val texts: Map<Int, String> = emptyMap(),
    val expanded: Map<Int, Boolean> = emptyMap(),
) {
    fun currentPage(form: QuestionAnswerForm): Int = minOf(page, maxOf(0, form.fields.size - 1))

    fun selected(index: Int): Set<Int> = selections[index].orEmpty()

    fun text(index: Int, form: QuestionAnswerForm): String = texts[index] ?: form.fields[index].prefill

    fun showsText(index: Int, form: QuestionAnswerForm): Boolean =
        form.fields[index].options.isEmpty() || (expanded[index] ?: text(index, form).isNotEmpty())

    fun isAnswered(index: Int, form: QuestionAnswerForm): Boolean =
        form.fields[index].isAnswered(selected(index), text(index, form))

    fun toggleText(index: Int, form: QuestionAnswerForm) = copy(expanded = expanded + (index to !showsText(index, form)))

    fun withText(text: String, index: Int, form: QuestionAnswerForm): QuestionAnswerDraft {
        val field = form.fields.getOrNull(index) ?: return this
        var next = copy(texts = texts + (index to text))
        if (field.allowsCustomAnswer && !field.multiple && text.isNotBlank()) {
            next = next.copy(selections = selections + (index to emptySet()))
        }
        return next
    }

    fun select(option: Int, index: Int, form: QuestionAnswerForm): QuestionAnswerDraft {
        val field = form.fields.getOrNull(index) ?: return this
        if (index != currentPage(form) || option !in field.options.indices) return this
        return when {
            // Unlike an ordinary single selection, leave time to add optional notes.
            field.isOtherOption(option) -> copy(
                selections = selections + (index to setOf(option)),
                expanded = expanded + (index to true),
            )
            field.multiple -> {
                val current = selected(index).filterNot(field::isOtherOption).toSet()
                copy(selections = selections + (index to if (option in current) current - option else current + option))
            }
            else -> {
                var next = copy(selections = selections + (index to setOf(option)))
                if (field.allowsCustomAnswer) next = next.copy(texts = texts + (index to ""))
                next.next(form)
            }
        }
    }

    fun previous(form: QuestionAnswerForm) = copy(page = maxOf(0, currentPage(form) - 1))

    fun next(form: QuestionAnswerForm): QuestionAnswerDraft {
        val index = currentPage(form)
        if (index !in form.fields.indices || !isAnswered(index, form)) return this
        return copy(page = minOf(index + 1, form.fields.size - 1))
    }

    fun submission(form: QuestionAnswerForm): PermissionAction? {
        if (form.fields.isEmpty() || !form.fields.indices.all { isAnswered(it, form) }) return null
        val answers = linkedMapOf<String, List<String>>()
        form.fields.forEachIndexed { index, field -> answers[field.key] = field.values(selected(index), text(index, form)) }
        return if (form.nestedAnswers) PermissionAction.NestedAnswers(answers) else PermissionAction.FlatAnswers(answers)
    }

    companion object {
        /** Bundle-friendly: only Int/String/Boolean inside Serializable collections. */
        val Saver: Saver<QuestionAnswerDraft, Any> = Saver(
            save = { draft ->
                arrayListOf(
                    draft.page,
                    HashMap(draft.selections.mapValues { ArrayList(it.value) }),
                    HashMap(draft.texts),
                    HashMap(draft.expanded),
                )
            },
            restore = { saved ->
                @Suppress("UNCHECKED_CAST")
                val list = saved as List<Any>
                QuestionAnswerDraft(
                    page = list[0] as Int,
                    selections = (list[1] as Map<Int, List<Int>>).mapValues { it.value.toSet() },
                    texts = list[2] as Map<Int, String>,
                    expanded = list[3] as Map<Int, Boolean>,
                )
            },
        )
    }
}

/** Option labels may end in " (Recommended)"; render that as a badge instead. */
internal data class QuestionOptionTitle(val text: String, val recommended: Boolean) {
    companion object {
        private const val SUFFIX = " (Recommended)"

        fun of(original: String): QuestionOptionTitle {
            val stripped = if (original.endsWith(SUFFIX)) original.dropLast(SUFFIX.length).trim() else ""
            return if (stripped.isNotEmpty()) QuestionOptionTitle(stripped, true) else QuestionOptionTitle(original, false)
        }
    }
}

internal enum class QuestionCardState {
    Answering, Submitting, Answered, Handled, Canceled, Failed, Waiting;

    companion object {
        fun of(tool: ChatToolCall, details: QuestionToolDetails, override: PermissionRowOverride?): QuestionCardState {
            val status = tool.permission?.status
            return when {
                tool.state == ToolState.ERROR -> Failed
                status == "denied" || status == "canceled" -> Canceled
                details.hasAnswers -> Answered
                override == PermissionRowOverride.AlreadyHandled -> Handled
                status == "pending" -> if (override == PermissionRowOverride.Resolving) Submitting else Answering
                tool.permission != null || tool.state == ToolState.COMPLETED -> Handled
                else -> Waiting
            }
        }
    }
}

/** One-line answer recap; `otherLabel`/`emptyLabel` are the localized display strings. */
internal fun questionAnswerSummary(question: QuestionDetail, otherLabel: String, emptyLabel: String): String? {
    val choices = question.options.filter { it.selected }.map {
        if (it.isOther) otherLabel else QuestionOptionTitle.of(it.label).text
    }
    val values = choices + question.otherAnswers + listOfNotNull(question.note?.let { it.ifEmpty { emptyLabel } })
    if (values.isEmpty()) return null
    val joined = values.joinToString(" · ").split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
    return if (joined.length > 240) joined.take(239) + "…" else joined
}
