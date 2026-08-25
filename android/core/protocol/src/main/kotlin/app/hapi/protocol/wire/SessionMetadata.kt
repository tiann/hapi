package app.hapi.protocol.wire

import kotlinx.serialization.Serializable

/**
 * Typed subset of the session `metadata` blob (`MetadataSchema`,
 * `shared/src/schemas.ts` — ~60 fields, most of them CLI/runner internals).
 * Only the fields a native client renders or branches on are modeled;
 * [HapiJson]'s `ignoreUnknownKeys` drops the rest on decode. This is safe
 * because clients never write metadata wholesale — mutations go through
 * dedicated REST endpoints (rename, summary, …).
 *
 * `path` and `host` are required, matching zod: the hub always writes them,
 * and the web client also fails the whole parse without them.
 */
@Serializable
data class SessionMetadata(
    val path: String,
    val host: String,
    val name: String? = null,
    val os: String? = null,
    val summary: MetadataSummary? = null,
    val machineId: String? = null,
    /** Agent flavor id (`claude`, `codex`, …) — resolve via `catalog.AgentFlavor`. */
    val flavor: String? = null,
    /** `'local' | 'remote' | 'pty'`. */
    val startingMode: String? = null,
    val lifecycleState: String? = null,
    val worktree: WorktreeMetadata? = null,
    val capabilities: SessionCapabilities? = null,
    /** Loopback MCP URL when the session's CLI happy server is running. */
    val hapiMcpUrl: String? = null,
    val slashCommands: List<String>? = null,
    val tools: List<String>? = null,
    // Per-flavor agent session ids (`MetadataSchema`) — the resume handle for
    // each CLI. Needed by the `SessionSummary.agentSessionId` projection
    // (`getSummaryAgentSessionId`, `shared/src/sessionSummary.ts`).
    val claudeSessionId: String? = null,
    val codexSessionId: String? = null,
    val geminiSessionId: String? = null,
    val opencodeSessionId: String? = null,
    val grokSessionId: String? = null,
    val agySessionId: String? = null,
    val cursorSessionId: String? = null,
    val kimiSessionId: String? = null,
    val copilotSessionId: String? = null,
    val piSessionId: String? = null,
)

/** `metadata.summary` on the detail session (`{text, updatedAt}`). */
@Serializable
data class MetadataSummary(
    val text: String,
    val updatedAt: Long,
)

/** `WorktreeMetadataSchema`. */
@Serializable
data class WorktreeMetadata(
    val basePath: String,
    val branch: String,
    val name: String,
    val worktreePath: String? = null,
    val createdAt: Long? = null,
)

/** `SessionCapabilitiesSchema`. */
@Serializable
data class SessionCapabilities(
    val terminal: Boolean? = null,
    val conversationHistory: ConversationHistoryCapabilities? = null,
)

/** `ConversationHistoryCapabilitiesSchema`. */
@Serializable
data class ConversationHistoryCapabilities(
    val forkCurrent: Boolean? = null,
    val forkAtMessage: Boolean? = null,
    val rewindToMessage: Boolean? = null,
)
