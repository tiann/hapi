package app.hapi.protocol.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Machine (runner host) row (`MachineSchema`, `shared/src/schemas.ts`).
 * Runner internals that v1 does not branch on stay raw [JsonElement].
 */
@Serializable
data class Machine(
    val id: String,
    val namespace: String,
    val seq: Long,
    val createdAt: Long,
    val updatedAt: Long,
    val active: Boolean,
    val activeAt: Long,
    val metadata: MachineMetadata? = null,
    val metadataVersion: Long,
    val runnerState: RunnerState? = null,
    val runnerStateVersion: Long,
    val health: MachineHealth? = null,
)

/** `MachineMetadataSchema`. */
@Serializable
data class MachineMetadata(
    val host: String,
    val platform: String,
    val happyCliVersion: String,
    val displayName: String? = null,
    val homeDir: String? = null,
    val happyHomeDir: String? = null,
    val happyLibDir: String? = null,
    val workspaceRoots: List<String>? = null,
    /** Machine-scoped RPC capability ids this runner registers. */
    val capabilities: List<String>? = null,
    @Serializable(with = LenientEpochMs::class)
    val startedCliMtimeMs: Long? = null,
    @Serializable(with = LenientEpochMs::class)
    val installedCliMtimeMs: Long? = null,
    val supervisedRestart: Boolean? = null,
)

/**
 * `RunnerStateSchema` — cheaply-typed scalars only; `capabilities` (agent
 * config descriptors) and `lastSpawnError` stay raw until a feature needs them.
 */
@Serializable
data class RunnerState(
    /** `'running' | 'shutting-down'` or any future string (zod union with string). */
    val status: String,
    val pid: Int? = null,
    val httpPort: Int? = null,
    val startedAt: Long? = null,
    val capabilities: JsonElement? = null,
    val shutdownRequestedAt: Long? = null,
    val shutdownSource: String? = null,
    val lastSpawnError: JsonElement? = null,
)

/** `MachineHealthSchema`. */
@Serializable
data class MachineHealth(
    val collectedAt: Long,
    val cpuCount: Int? = null,
    val load1m: Double? = null,
    val cpuPercent: Double? = null,
    val memoryPercent: Double? = null,
    val uptimeSeconds: Double? = null,
)

/**
 * Flat patch variant of the `machine-updated` SSE payload
 * (`MachinePatchSchema` — strict in zod).
 */
@Serializable
data class MachinePatch(
    val active: Boolean? = null,
    val activeAt: Long? = null,
    val updatedAt: Long? = null,
)

object MachinePatches {
    private val KNOWN_KEYS = setOf("active", "activeAt", "updatedAt")

    /**
     * Strict + non-empty parse mirroring the web's `getMachinePatch`
     * (`MachinePatchSchema.safeParse` + key-count check): any unknown key or
     * mistyped value → `null` (caller falls back to refetching machines), and
     * an empty `{}` is also `null`. Strictness is what separates a patch from
     * a full [Machine] payload.
     */
    fun parse(element: JsonElement?): MachinePatch? {
        val obj = element as? JsonObject ?: return null
        if (obj.isEmpty() || obj.keys.any { it !in KNOWN_KEYS }) return null
        val active = obj["active"]?.let { it.boolOrNull ?: return null }
        val activeAt = obj["activeAt"]?.let { it.longOrNull ?: return null }
        val updatedAt = obj["updatedAt"]?.let { it.longOrNull ?: return null }
        return MachinePatch(active = active, activeAt = activeAt, updatedAt = updatedAt)
    }
}
