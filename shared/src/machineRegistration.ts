/**
 * Registration-time machine metadata refresh.
 *
 * Hub `getOrCreateMachine` historically returned stale metadata for existing
 * machines, so upgraded runners kept advertising old versions / missing
 * capabilities until something else wrote metadata. Compare + merge here so
 * register and reconnect paths can refresh identity fields without wiping
 * operator-set displayName.
 */

const IDENTITY_KEYS = [
    'host',
    'platform',
    'happyCliVersion',
    'homeDir',
    'happyHomeDir',
    'happyLibDir',
    'startedCliMtimeMs',
    'installedCliMtimeMs',
] as const

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    return value as Record<string, unknown>
}

export function sortedCapabilities(caps: unknown): string[] {
    if (!Array.isArray(caps)) {
        return []
    }
    return caps.filter((cap): cap is string => typeof cap === 'string').slice().sort()
}

function capabilitiesEqual(left: unknown, right: unknown): boolean {
    const a = sortedCapabilities(left)
    const b = sortedCapabilities(right)
    return a.length === b.length && a.every((value, index) => value === b[index])
}

function workspaceRootsEqual(left: unknown, right: unknown): boolean {
    const normalize = (value: unknown): string[] => {
        if (!Array.isArray(value)) {
            return []
        }
        return value.filter((path): path is string => typeof path === 'string').slice().sort()
    }
    const a = normalize(left)
    const b = normalize(right)
    return a.length === b.length && a.every((value, index) => value === b[index])
}

/** True when registering `incoming` should replace hub-stored identity metadata. */
export function machineRegistrationNeedsRefresh(existing: unknown, incoming: unknown): boolean {
    const current = asRecord(existing)
    const next = asRecord(incoming)
    if (!next) {
        return false
    }
    if (!current) {
        return true
    }
    for (const key of IDENTITY_KEYS) {
        if (next[key] !== undefined && next[key] !== current[key]) {
            return true
        }
    }
    if (next.capabilities !== undefined && !capabilitiesEqual(current.capabilities, next.capabilities)) {
        return true
    }
    if (next.workspaceRoots !== undefined && !workspaceRootsEqual(current.workspaceRoots, next.workspaceRoots)) {
        return true
    }
    return false
}

/**
 * Merge registration metadata: incoming wins for identity fields; preserve
 * operator displayName when the client did not send one.
 */
export function mergeMachineRegistrationMetadata(existing: unknown, incoming: unknown): Record<string, unknown> {
    const current = asRecord(existing) ?? {}
    const next = asRecord(incoming) ?? {}
    const merged: Record<string, unknown> = {
        ...current,
        ...next,
    }
    if (next.displayName === undefined && current.displayName !== undefined) {
        merged.displayName = current.displayName
    }
    return merged
}
