/**
 * Resolve a spawn-peer `--machine` / MCP `machine` selector to a hub machine id.
 *
 * Matches estate `hapi-spawn-peer.sh`: UUID (or exact id) passthrough; otherwise
 * hostname / metadata.host / metadata.name via GET /api/machines.
 * Label matches that hit more than one online machine fail closed (hub does
 * not enforce unique hostnames / display names).
 */

export type HubMachineListEntry = {
    id?: unknown
    hostname?: unknown
    host?: unknown
    metadata?: {
        host?: unknown
        hostname?: unknown
        name?: unknown
        displayName?: unknown
    } | null
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export class AmbiguousSpawnMachineError extends Error {
    readonly matches: string[]

    constructor(selector: string, matches: string[]) {
        const unique = [...new Set(matches)]
        super(
            `machine=${selector} matches ${unique.length} online runners `
            + `(${unique.join(', ')}). Use a machine UUID instead.`
        )
        this.name = 'AmbiguousSpawnMachineError'
        this.matches = unique
    }
}

function asNonEmptyString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function machineLabelCandidates(entry: HubMachineListEntry): string[] {
    const meta = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : null
    return [
        asNonEmptyString(entry.id),
        asNonEmptyString(entry.hostname),
        asNonEmptyString(entry.host),
        asNonEmptyString(meta?.host),
        asNonEmptyString(meta?.hostname),
        asNonEmptyString(meta?.name),
        asNonEmptyString(meta?.displayName),
    ].filter(Boolean)
}

/**
 * Pure resolver against an already-fetched machine list.
 * Returns the machine id, or null when no match.
 * Throws AmbiguousSpawnMachineError when a non-id label matches 2+ machines.
 */
export function resolveSpawnMachineIdFromList(
    want: string,
    machines: HubMachineListEntry[]
): string | null {
    const needle = want.trim()
    if (!needle) {
        return null
    }

    // Exact id match (UUID or non-UUID ids like "Teemo")
    for (const entry of machines) {
        const id = asNonEmptyString(entry.id)
        if (id && id === needle) {
            return id
        }
    }

    // UUID-shaped selectors may target a briefly offline machine; passthrough
    // like the estate wrapper (spawn will 404 if truly unknown).
    if (UUID_RE.test(needle)) {
        return needle
    }

    const matches: string[] = []
    for (const entry of machines) {
        const id = asNonEmptyString(entry.id)
        if (!id) continue
        const labels = machineLabelCandidates(entry)
        if (labels.some((label) => label === needle)) {
            matches.push(id)
        }
    }

    const unique = [...new Set(matches)]
    if (unique.length > 1) {
        throw new AmbiguousSpawnMachineError(needle, unique)
    }
    if (unique.length === 1) {
        return unique[0]!
    }

    return null
}

export function isUuidMachineSelector(want: string): boolean {
    return UUID_RE.test(want.trim())
}
