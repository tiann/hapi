import { RPC_METHODS } from './rpcMethods'

/**
 * Capabilities the current runner generation advertises to the hub.
 *
 * `piExistingSessionResume` gates the Pi native-history resume path in
 * hub/src/sync/syncEngine.ts: the runner must be able to hand back an
 * existing native Pi process. The runner declares it at registration
 * (HTTP POST /machines) and again on every socket connect, because the hub
 * merges registration-time runner state only for brand-new machines and the
 * socket heartbeat owns the persisted runner_state afterwards — without the
 * socket-side advertisement, a runner upgraded in place would never get its
 * new capabilities observed by the hub.
 */
import { getBuiltinAgentConfigDescriptors } from './agentConfig'

export const RUNNER_CAPABILITIES = {
    piExistingSessionResume: true as const,
    agentConfigs: getBuiltinAgentConfigDescriptors()
}

export type RunnerCapabilities = typeof RUNNER_CAPABILITIES

/**
 * Machine-scoped capabilities runners advertise on connect.
 * Hub features that hard-depend on a machine RPC must list that capability
 * in {@link REQUIRED_MACHINE_CAPABILITIES} so skew surfaces as a banner
 * instead of a silent fail-closed product bug.
 */
export const MACHINE_CAPABILITIES = {
    AgentAvailability: RPC_METHODS.AgentAvailability,
    CursorChatStoreStatus: RPC_METHODS.CursorChatStoreStatus,
    StopRunner: RPC_METHODS.StopRunner,
} as const

export type MachineCapability =
    (typeof MACHINE_CAPABILITIES)[keyof typeof MACHINE_CAPABILITIES]

/** Capabilities this CLI generation registers on the machine socket. */
export const CURRENT_MACHINE_CAPABILITIES: readonly MachineCapability[] = [
    MACHINE_CAPABILITIES.AgentAvailability,
    MACHINE_CAPABILITIES.CursorChatStoreStatus,
    MACHINE_CAPABILITIES.StopRunner,
]

/**
 * Capabilities the hub requires on every connected runner for features it
 * hard-depends on. Missing entries → operator-visible skew banner (+ optional
 * stop-runner ensure when a newer binary is already on disk).
 */
export const REQUIRED_MACHINE_CAPABILITIES: readonly MachineCapability[] = [
    MACHINE_CAPABILITIES.AgentAvailability,
    MACHINE_CAPABILITIES.CursorChatStoreStatus,
]

export function missingRequiredCapabilities(
    advertised: readonly string[] | null | undefined,
): MachineCapability[] {
    const set = new Set(advertised ?? [])
    return REQUIRED_MACHINE_CAPABILITIES.filter((cap) => !set.has(cap))
}

export function isMachineCapabilitySkewed(
    advertised: readonly string[] | null | undefined,
): boolean {
    return missingRequiredCapabilities(advertised).length > 0
}

/** True when the running process started from a different CLI binary/mtime than what's installed now. */
export function cliBinaryUpdatedOnDisk(metadata: {
    startedCliMtimeMs?: number | null
    installedCliMtimeMs?: number | null
} | null | undefined): boolean {
    const started = metadata?.startedCliMtimeMs
    const installed = metadata?.installedCliMtimeMs
    return typeof started === 'number'
        && typeof installed === 'number'
        && Number.isFinite(started)
        && Number.isFinite(installed)
        && started !== installed
}
