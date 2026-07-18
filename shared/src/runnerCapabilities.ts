import { RPC_METHODS } from './rpcMethods'

/**
 * Machine-scoped capabilities runners advertise on connect.
 * Hub features that hard-depend on a machine RPC must list that capability
 * in {@link REQUIRED_MACHINE_CAPABILITIES} so skew surfaces as a banner
 * instead of a silent fail-closed product bug.
 */
export const MACHINE_CAPABILITIES = {
    CursorChatStoreStatus: RPC_METHODS.CursorChatStoreStatus,
    StopRunner: RPC_METHODS.StopRunner,
} as const

export type MachineCapability =
    (typeof MACHINE_CAPABILITIES)[keyof typeof MACHINE_CAPABILITIES]

/** Capabilities this CLI generation registers on the machine socket. */
export const CURRENT_MACHINE_CAPABILITIES: readonly MachineCapability[] = [
    MACHINE_CAPABILITIES.CursorChatStoreStatus,
    MACHINE_CAPABILITIES.StopRunner,
]

/**
 * Capabilities the hub requires on every connected runner for features it
 * hard-depends on. Missing entries → operator-visible skew banner (+ optional
 * stop-runner ensure when a newer binary is already on disk).
 */
export const REQUIRED_MACHINE_CAPABILITIES: readonly MachineCapability[] = [
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
