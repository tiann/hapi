package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Port of `web/src/chat/types.ts`.
 *
 * Representation conventions (see also [JsInterop.kt](JsInterop.kt)):
 * - TS `unknown` fields are [JsonElement].
 * - TS tri-state `field?: T` collapses to a nullable Kotlin field wherever the
 *   web pipeline observes `undefined` and `null` identically; where the
 *   distinction is observable ([ChatToolCall.input], tool `progress`,
 *   permission spread-merges) the type keeps it explicit.
 * - Reduction mutates blocks in place exactly like the TS reducers do, so the
 *   block types are classes with `var` state, compared by identity.
 */

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** `UsageData` — numbers stay [Double] (JS number semantics). */
data class UsageData(
    val inputTokens: Double,
    val outputTokens: Double,
    val cacheCreationInputTokens: Double? = null,
    val cacheReadInputTokens: Double? = null,
    val contextTokens: Double? = null,
    val contextWindow: Double? = null,
    val threadId: String? = null,
    val scopeRole: String? = null,
    val serviceTier: String? = null,
)

// ---------------------------------------------------------------------------
// AgentEvent
// ---------------------------------------------------------------------------

/**
 * `AgentEvent` — an open union. Every variant wraps the verbatim event object
 * ([raw]): wire `'event'`-family payloads are carried untouched (unknown extra
 * keys included), and synthesized events build [raw] with exactly the keys the
 * TS object literals produce. The projection emits [raw] as-is.
 */
sealed class AgentEvent {
    abstract val raw: JsonObject

    val type: String get() = asString(raw["type"]) ?: ""

    class Switch(override val raw: JsonObject) : AgentEvent() {
        val mode: String? get() = asString(raw["mode"])
    }

    class Message(override val raw: JsonObject) : AgentEvent() {
        val message: String? get() = asString(raw["message"])
    }

    class ErrorEvent(override val raw: JsonObject) : AgentEvent() {
        val message: String? get() = asString(raw["message"])
    }

    class TitleChanged(override val raw: JsonObject) : AgentEvent() {
        val title: String? get() = asString(raw["title"])
    }

    class LimitReached(override val raw: JsonObject) : AgentEvent() {
        val endsAt: Double? get() = asNumber(raw["endsAt"])
        val limitType: String? get() = asString(raw["limitType"])
    }

    class LimitWarning(override val raw: JsonObject) : AgentEvent() {
        val utilization: Double? get() = asNumber(raw["utilization"])
        val endsAt: Double? get() = asNumber(raw["endsAt"])
        val limitType: String? get() = asString(raw["limitType"])
    }

    class Ready(override val raw: JsonObject) : AgentEvent()

    class ApiError(override val raw: JsonObject) : AgentEvent() {
        val retryAttempt: Double? get() = asNumber(raw["retryAttempt"])
        val maxRetries: Double? get() = asNumber(raw["maxRetries"])
        val error: JsonElement? get() = raw["error"]
    }

    class TurnDuration(override val raw: JsonObject) : AgentEvent() {
        val durationMs: Double? get() = asNumber(raw["durationMs"])
        val targetMessageId: String? get() = asString(raw["targetMessageId"])
    }

    class Microcompact(override val raw: JsonObject) : AgentEvent()

    class Compact(override val raw: JsonObject) : AgentEvent()

    class CompactSummary(override val raw: JsonObject) : AgentEvent() {
        val summary: String? get() = asString(raw["summary"])
    }

    class Recap(override val raw: JsonObject) : AgentEvent() {
        val text: String? get() = asString(raw["text"])
    }

    class ThreadGoalUpdated(override val raw: JsonObject) : AgentEvent() {
        val goal: JsonObject? get() = asObject(raw["goal"])
    }

    class ThreadGoalCleared(override val raw: JsonObject) : AgentEvent()

    class AbortRestore(override val raw: JsonObject) : AgentEvent()

    /** Open tail — any other `type` (`agent-run-*`, `token-count`, unknown wire events). */
    class Custom(override val raw: JsonObject) : AgentEvent()

    companion object {
        /** Wrap a raw event object (must already carry a string `type`). */
        fun of(raw: JsonObject): AgentEvent = when (asString(raw["type"])) {
            "switch" -> Switch(raw)
            "message" -> Message(raw)
            "error" -> ErrorEvent(raw)
            "title-changed" -> TitleChanged(raw)
            "limit-reached" -> LimitReached(raw)
            "limit-warning" -> LimitWarning(raw)
            "ready" -> Ready(raw)
            "api-error" -> ApiError(raw)
            "turn-duration" -> TurnDuration(raw)
            "microcompact" -> Microcompact(raw)
            "compact" -> Compact(raw)
            "compact-summary" -> CompactSummary(raw)
            "recap" -> Recap(raw)
            "thread-goal-updated" -> ThreadGoalUpdated(raw)
            "thread-goal-cleared" -> ThreadGoalCleared(raw)
            "abort-restore" -> AbortRestore(raw)
            else -> Custom(raw)
        }
    }
}

// ---------------------------------------------------------------------------
// Normalized agent content
// ---------------------------------------------------------------------------

/** `ToolResultPermission` — permission decision embedded in a Claude tool_result block. */
data class ToolResultPermission(
    val date: Double,
    /** `'approved' | 'denied'`. */
    val result: String,
    val mode: String? = null,
    val allowedTools: List<String>? = null,
    /** `'approved' | 'approved_for_session' | 'denied' | 'abort'`. */
    val decision: String? = null,
)

sealed class NormalizedAgentContent {

    data class Text(
        val text: String,
        val uuid: String,
        val streamId: String? = null,
        val parentUUID: String? = null,
    ) : NormalizedAgentContent()

    data class Reasoning(
        val text: String,
        val uuid: String,
        val streamId: String? = null,
        val parentUUID: String? = null,
    ) : NormalizedAgentContent()

    data class ToolUse(
        val id: String,
        val name: String,
        /** Kotlin null = key absent in the wire block; JsonNull = explicit null. */
        val input: JsonElement?,
        val description: String?,
        val nativeTitle: String? = null,
        val nativeKind: String? = null,
        /** Tri-state: `'progress' in data` in TS. */
        val hasProgress: Boolean = false,
        val progress: JsonElement? = null,
        val uuid: String,
        val parentUUID: String? = null,
    ) : NormalizedAgentContent()

    data class ToolResult(
        val toolUseId: String,
        /** Kotlin null = TS undefined (no result payload); JsonNull = explicit null. */
        val content: JsonElement?,
        val isError: Boolean,
        val uuid: String,
        val parentUUID: String? = null,
        val permissions: ToolResultPermission? = null,
    ) : NormalizedAgentContent()

    data class GeneratedImage(
        val imageId: String,
        val fileName: String,
        val mimeType: String?,
        val uuid: String,
        val parentUUID: String? = null,
        val source: InlineMediaSource? = null,
    ) : NormalizedAgentContent()

    data class CodexReviewContent(
        val review: CodexReview,
        val uuid: String,
        val parentUUID: String? = null,
    ) : NormalizedAgentContent()

    data class Summary(val summary: String) : NormalizedAgentContent()

    data class Sidechain(
        val uuid: String,
        val parentUUID: String? = null,
        val prompt: String,
    ) : NormalizedAgentContent()
}

internal fun NormalizedAgentContent.uuidOrNull(): String? = when (this) {
    is NormalizedAgentContent.Text -> uuid
    is NormalizedAgentContent.Reasoning -> uuid
    is NormalizedAgentContent.ToolUse -> uuid
    is NormalizedAgentContent.ToolResult -> uuid
    is NormalizedAgentContent.GeneratedImage -> uuid
    is NormalizedAgentContent.CodexReviewContent -> uuid
    is NormalizedAgentContent.Sidechain -> uuid
    is NormalizedAgentContent.Summary -> null
}

internal fun NormalizedAgentContent.parentUuidOrNull(): String? = when (this) {
    is NormalizedAgentContent.Text -> parentUUID
    is NormalizedAgentContent.Reasoning -> parentUUID
    is NormalizedAgentContent.ToolUse -> parentUUID
    is NormalizedAgentContent.ToolResult -> parentUUID
    is NormalizedAgentContent.GeneratedImage -> parentUUID
    is NormalizedAgentContent.CodexReviewContent -> parentUUID
    is NormalizedAgentContent.Sidechain -> parentUUID
    is NormalizedAgentContent.Summary -> null
}

// ---------------------------------------------------------------------------
// Codex review
// ---------------------------------------------------------------------------

data class CodexReviewFinding(
    val title: String,
    val body: String,
    val priority: Double?,
    val confidenceScore: Double?,
    val filePath: String?,
    val lineStart: Double?,
    val lineEnd: Double?,
)

data class CodexReview(
    val findings: List<CodexReviewFinding>,
    val overallCorrectness: String?,
    val overallExplanation: String?,
    val overallConfidenceScore: Double?,
)

/** v1 inline media provenance (`web/src/chat/inlineMediaSource.ts`). */
data class InlineMediaSource(
    /** `'mcp' | 'acp' | 'tool_result'`. */
    val ingress: String,
    val flavor: String? = null,
    val toolCallId: String? = null,
    val toolName: String? = null,
)

fun inlineMediaSourceFromWire(value: JsonElement?): InlineMediaSource? {
    val record = asObject(value) ?: return null
    val ingress = asString(record["ingress"]) ?: asString(record["path"])
    if (ingress != "mcp" && ingress != "acp" && ingress != "tool_result") return null
    return InlineMediaSource(
        ingress = ingress,
        flavor = asString(record["flavor"]),
        toolCallId = asString(record["toolCallId"]) ?: asString(record["tool_call_id"]),
        toolName = asString(record["toolName"]) ?: asString(record["tool_name"]),
    )
}

// ---------------------------------------------------------------------------
// Normalized message
// ---------------------------------------------------------------------------

/** Parsed user attachment (`AttachmentMetadata` on the web side). */
data class ChatAttachment(
    val id: String,
    val filename: String,
    val mimeType: String,
    val size: Double,
    val path: String,
    val previewUrl: String? = null,
)

/** `NormalizedMessage` — one wire message after decode, before reduction. */
sealed class NormalizedMessage {
    abstract val id: String
    abstract val localId: String?
    abstract val createdAt: Long
    abstract val isSidechain: Boolean
    abstract val meta: JsonElement?
    abstract val usage: UsageData?
    abstract val status: String?
    abstract val originalText: String?
    abstract val invokedAt: Long?
    abstract val model: String?
    abstract val agentTimestamp: Long?

    data class User(
        override val id: String,
        override val localId: String?,
        override val createdAt: Long,
        val text: String,
        val attachments: List<ChatAttachment>? = null,
        override val isSidechain: Boolean = false,
        override val meta: JsonElement? = null,
        override val usage: UsageData? = null,
        override val status: String? = null,
        override val originalText: String? = null,
        override val invokedAt: Long? = null,
        override val model: String? = null,
        override val agentTimestamp: Long? = null,
    ) : NormalizedMessage()

    data class Agent(
        override val id: String,
        override val localId: String?,
        override val createdAt: Long,
        val content: List<NormalizedAgentContent>,
        override val isSidechain: Boolean = false,
        val parentToolUseId: String? = null,
        override val meta: JsonElement? = null,
        override val usage: UsageData? = null,
        override val status: String? = null,
        override val originalText: String? = null,
        override val invokedAt: Long? = null,
        override val model: String? = null,
        override val agentTimestamp: Long? = null,
    ) : NormalizedMessage()

    data class Event(
        override val id: String,
        override val localId: String?,
        override val createdAt: Long,
        val event: AgentEvent,
        override val isSidechain: Boolean = false,
        override val meta: JsonElement? = null,
        override val usage: UsageData? = null,
        override val status: String? = null,
        override val originalText: String? = null,
        override val invokedAt: Long? = null,
        override val model: String? = null,
        override val agentTimestamp: Long? = null,
    ) : NormalizedMessage()
}

// ---------------------------------------------------------------------------
// Tool permission (spread-merge aware)
// ---------------------------------------------------------------------------

/**
 * `ToolPermission`. The TS reducers merge permission objects with object
 * spreads, where a key *present with `undefined`* overwrites while an *absent*
 * key preserves — [presence] records which keys the source literal carried so
 * [mergedWith] reproduces `{ ...existing, ...seed }` exactly.
 */
data class ToolPermission(
    val id: String,
    /** `'pending' | 'approved' | 'denied' | 'canceled'`. */
    val status: String,
    val reason: String? = null,
    val mode: String? = null,
    val allowedTools: List<String>? = null,
    /** `'approved' | 'approved_for_session' | 'denied' | 'abort'`. */
    val decision: String? = null,
    /** Verbatim wire answers (flat or nested format). */
    val answers: JsonElement? = null,
    val date: Double? = null,
    val createdAt: Long? = null,
    val completedAt: Long? = null,
    val presence: Set<String>,
) {
    /** `{ ...this, ...seed }`. */
    fun mergedWith(seed: ToolPermission): ToolPermission = ToolPermission(
        id = if ("id" in seed.presence) seed.id else id,
        status = if ("status" in seed.presence) seed.status else status,
        reason = if ("reason" in seed.presence) seed.reason else reason,
        mode = if ("mode" in seed.presence) seed.mode else mode,
        allowedTools = if ("allowedTools" in seed.presence) seed.allowedTools else allowedTools,
        decision = if ("decision" in seed.presence) seed.decision else decision,
        answers = if ("answers" in seed.presence) seed.answers else answers,
        date = if ("date" in seed.presence) seed.date else date,
        createdAt = if ("createdAt" in seed.presence) seed.createdAt else createdAt,
        completedAt = if ("completedAt" in seed.presence) seed.completedAt else completedAt,
        presence = presence + seed.presence,
    )

    companion object {
        /** Key set of the `getPermissions` completed-request literal. */
        val COMPLETED_KEYS = setOf(
            "id", "status", "reason", "mode", "decision", "allowedTools", "answers", "createdAt", "completedAt",
        )

        /** Key set of the `getPermissions` pending-request literal. */
        val PENDING_KEYS = setOf("id", "status", "createdAt")

        /** Key set of the tool_result `permissionFromResult` literal. */
        val FROM_RESULT_KEYS = setOf("id", "status", "date", "mode", "allowedTools", "decision")
    }
}

// ---------------------------------------------------------------------------
// Chat tool call + blocks
// ---------------------------------------------------------------------------

object ToolState {
    const val PENDING = "pending"
    const val RUNNING = "running"
    const val COMPLETED = "completed"
    const val ERROR = "error"
}

/**
 * `ChatToolCall`. Immutable value replaced wholesale on update (mirrors the
 * TS `block.tool = { ...block.tool, ... }` pattern).
 *
 * [input]/[result]: Kotlin null = TS undefined (projection omits the key);
 * [kotlinx.serialization.json.JsonNull] = explicit null (projected as null).
 */
data class ChatToolCall(
    val id: String,
    val name: String,
    val state: String,
    val input: JsonElement?,
    val createdAt: Long,
    val startedAt: Double? = null,
    val completedAt: Double? = null,
    val execStartedAt: Double? = null,
    val execCompletedAt: Double? = null,
    val description: String?,
    val nativeTitle: String? = null,
    val nativeKind: String? = null,
    val result: JsonElement? = null,
    val permission: ToolPermission? = null,
)

sealed interface VisibleChatBlock

sealed class ChatBlock : VisibleChatBlock {
    abstract val kind: String
    abstract val id: String
    abstract var createdAt: Long
    abstract var invokedAt: Long?
    abstract var meta: JsonElement?
}

class UserTextBlock(
    override val id: String,
    val localId: String?,
    override var createdAt: Long,
    override var invokedAt: Long?,
    var text: String,
    var attachments: List<ChatAttachment>?,
    var status: String?,
    var originalText: String?,
    override var meta: JsonElement?,
) : ChatBlock() {
    override val kind: String get() = "user-text"
}

class AgentTextBlock(
    override val id: String,
    val localId: String?,
    override var createdAt: Long,
    override var invokedAt: Long?,
    var durationMs: Double? = null,
    var usage: UsageData? = null,
    var model: String? = null,
    var text: String,
    override var meta: JsonElement?,
) : ChatBlock() {
    override val kind: String get() = "agent-text"
}

class AgentReasoningBlock(
    override val id: String,
    val localId: String?,
    override var createdAt: Long,
    override var invokedAt: Long?,
    var durationMs: Double? = null,
    var usage: UsageData? = null,
    var model: String? = null,
    var text: String,
    override var meta: JsonElement?,
) : ChatBlock() {
    override val kind: String get() = "agent-reasoning"
}

class CodexReviewBlock(
    override val id: String,
    val localId: String?,
    override var createdAt: Long,
    override var invokedAt: Long?,
    var durationMs: Double? = null,
    var usage: UsageData? = null,
    var model: String? = null,
    val review: CodexReview,
    override var meta: JsonElement?,
) : ChatBlock() {
    override val kind: String get() = "codex-review"
}

class CliOutputBlock(
    override val id: String,
    val localId: String?,
    override var createdAt: Long,
    override var invokedAt: Long?,
    var durationMs: Double? = null,
    var usage: UsageData? = null,
    var model: String? = null,
    var text: String,
    /** `'user' | 'assistant'`. */
    val source: String,
    override var meta: JsonElement?,
) : ChatBlock() {
    override val kind: String get() = "cli-output"
}

class GeneratedImageBlock(
    override val id: String,
    val localId: String?,
    override var createdAt: Long,
    override var invokedAt: Long?,
    val imageId: String,
    val fileName: String,
    val mimeType: String?,
    val source: InlineMediaSource?,
    override var meta: JsonElement?,
) : ChatBlock() {
    override val kind: String get() = "generated-image"
}

class AgentEventBlock(
    override val id: String,
    override var createdAt: Long,
    override var invokedAt: Long?,
    var model: String? = null,
    val event: AgentEvent,
    override var meta: JsonElement?,
) : ChatBlock() {
    override val kind: String get() = "agent-event"
}

class ToolCallBlock(
    override val id: String,
    val localId: String?,
    override var createdAt: Long,
    override var invokedAt: Long?,
    var durationMs: Double? = null,
    var usage: UsageData? = null,
    var model: String? = null,
    var tool: ChatToolCall,
    var children: List<ChatBlock>,
    override var meta: JsonElement?,
) : ChatBlock() {
    override val kind: String get() = "tool-call"
}
