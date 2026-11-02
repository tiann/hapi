package app.hapi.protocol.wire

/**
 * Runner-capability skew detection — the Android twin of
 * `shared/src/runnerCapabilities.ts`.
 *
 * The hub hard-depends on a fixed set of machine-scoped RPC capabilities
 * ([REQUIRED_MACHINE_CAPABILITIES]); a runner that does not advertise them
 * (older CLI generation) must surface as an operator-visible banner instead
 * of a silent fail-closed product bug. The manual-restart escape hatch only
 * helps once a newer CLI binary is already on disk ([cliBinaryUpdatedOnDisk])
 * and the runner is supervised (its supervisor relaunches it after the stop).
 */
object RunnerSkew {

    /** `RPC_METHODS.AgentAvailability` (`shared/src/rpcMethods.ts`). */
    const val CAPABILITY_AGENT_AVAILABILITY = "agent-availability"

    /** `RPC_METHODS.CursorChatStoreStatus`. */
    const val CAPABILITY_CURSOR_CHAT_STORE_STATUS = "cursor-chat-store-status"

    /**
     * Capabilities required on every connected runner. Kept as a `val` list
     * (not a set) so missing-capability reporting stays deterministic.
     */
    val REQUIRED_MACHINE_CAPABILITIES: List<String> =
        listOf(CAPABILITY_AGENT_AVAILABILITY, CAPABILITY_CURSOR_CHAT_STORE_STATUS)

    /**
     * The required capabilities absent from [advertised]. Null/empty
     * advertised lists (older runners never sent any) count as fully skewed.
     */
    fun missingRequiredCapabilities(advertised: List<String>?): List<String> {
        val set = advertised?.toSet() ?: emptySet()
        return REQUIRED_MACHINE_CAPABILITIES.filter { it !in set }
    }

    /** True when [advertised] lacks any required capability. */
    fun isMachineCapabilitySkewed(advertised: List<String>?): Boolean =
        missingRequiredCapabilities(advertised).isNotEmpty()

    /**
     * True when the running process started from a different CLI binary than
     * what is installed now (mtime drift). Both stamps must be present —
     * the reference's `Number.isFinite` guards are vacuous for `Long`.
     */
    fun cliBinaryUpdatedOnDisk(metadata: MachineMetadata?): Boolean {
        val started = metadata?.startedCliMtimeMs ?: return false
        val installed = metadata?.installedCliMtimeMs ?: return false
        return started != installed
    }
}
