/**
 * How a hub offers CLI upgrades to connected runners.
 *
 * - npm: remotes install @twsxtd/hapi@targetVersion from the registry
 * - hub-artifact: remotes download a hub-built CLI binary (source/soup hubs)
 * - off: disabled via override
 */
export type UpgradeChannel = 'npm' | 'hub-artifact' | 'off'

export const NPM_PACKAGE_NAME = '@twsxtd/hapi'

export type DetectUpgradeChannelInput = {
    /** HAPI_UPGRADE_CHANNEL override (npm|hub-artifact|off). */
    envChannel?: string | null
    isCompiled: boolean
    /** process.execPath or resolved hapi entry. */
    execPath: string
    /** CLI projectPath() (directory containing cli package.json). */
    projectPath: string
    /** True when projectPath's parent looks like a hapi monorepo (hub/ + shared/). */
    monorepoRootExists: boolean
}

function normalizeOverride(raw: string | null | undefined): UpgradeChannel | null {
    if (raw == null) {
        return null
    }
    const value = raw.trim().toLowerCase()
    if (!value) {
        return null
    }
    if (value === 'npm' || value === 'hub-artifact' || value === 'off') {
        return value
    }
    // Fail closed: a typo must not fall through to npm/hub-artifact and defeat
    // an intended kill switch when fleet policy is `auto`.
    throw new Error(
        `Invalid HAPI_UPGRADE_CHANNEL="${raw.trim()}"; expected npm, hub-artifact, or off`,
    )
}

function pathLooksLikeNpmPackage(path: string): boolean {
    const normalized = path.replace(/\\/g, '/')
    return normalized.includes('/node_modules/@twsxtd/hapi')
        || normalized.includes('/node_modules/@twsxtd/hapi/')
}

/**
 * Pure detection of the hub upgrade channel from runtime facts.
 * Hub wires real fs/env into {@link DetectUpgradeChannelInput}.
 */
export function detectUpgradeChannel(input: DetectUpgradeChannelInput): UpgradeChannel {
    const override = normalizeOverride(input.envChannel)
    if (override) {
        return override
    }

    if (pathLooksLikeNpmPackage(input.execPath) || pathLooksLikeNpmPackage(input.projectPath)) {
        return 'npm'
    }

    if (input.monorepoRootExists) {
        return 'hub-artifact'
    }

    // Single-exe / unknown install without a monorepo → published package path.
    return 'npm'
}

export type HubUpgradeOffer = {
    channel: UpgradeChannel
    /** CLI package version the hub wants remotes to match. */
    targetVersion: string
    /** Capabilities the hub requires after upgrade. */
    targetCapabilities: readonly string[]
    /**
     * Build generation for hub-artifact (typically monorepo source fingerprint).
     * Same package version with a new soup rebuild changes this so remotes
     * still apply; omit/empty for npm or when unknown.
     */
    targetGeneration?: string
    npmPackage?: string
    artifact?: {
        /** Absolute or hub-relative URL path, e.g. /api/upgrade/cli-artifact?... */
        url: string
        sha256: string
        platform: string
        arch: string
        sizeBytes: number
    }
}

/**
 * Compare HAPI package versions as major.minor.patch.
 * Returns -1 / 0 / 1, or null when either side is not a usable numeric semver.
 */
export function compareHapiVersions(left: string, right: string): number | null {
    const parse = (raw: string): [number, number, number] | null => {
        const cleaned = raw.trim().replace(/^v/i, '')
        const core = cleaned.split(/[-+]/, 1)[0] ?? ''
        const parts = core.split('.').map((part) => Number(part))
        if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) {
            return null
        }
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
    }
    const a = parse(left)
    const b = parse(right)
    if (!a || !b) {
        return null
    }
    for (let i = 0; i < 3; i++) {
        if (a[i]! < b[i]!) {
            return -1
        }
        if (a[i]! > b[i]!) {
            return 1
        }
    }
    return 0
}

export type MachineTrailsOptions = {
    /**
     * Soup / systemd hosts with `versionHandoffDisabled` never write an
     * upgrade-target marker, so they never advertise `cliArtifactGeneration`.
     * Treating that omission as generation drift makes the banner a permanent
     * false positive. Callers should set this for handoff-disabled machines.
     */
    ignoreGenerationDrift?: boolean
}

/**
 * True when a runner advertising `version`/`capabilities`/`generation` is behind
 * `offer` and the hub should auto-nudge it to the hub's generation.
 *
 * Fires on EITHER pure semver drift (`version !== targetVersion`), a missing
 * target capability, OR hub-artifact generation drift (same semver, new soup
 * rebuild). Mirrors the CLI-side `shouldApplyUpgradeOffer` apply decision from
 * the hub's view of advertised metadata.
 *
 * Returns false when there's no meaningful target to chase: channel `off`, or
 * the hub could not resolve its own version (the `0.0.0` fallback). Never chase
 * a bogus target or push `@twsxtd/hapi@0.0.0`.
 */
export function machineTrailsUpgradeOffer(
    offer: HubUpgradeOffer,
    version: string | null | undefined,
    capabilities: readonly string[] | null | undefined,
    generation?: string | null | undefined,
    options?: MachineTrailsOptions,
): boolean {
    if (offer.channel === 'off') {
        return false
    }
    if (!offer.targetVersion || offer.targetVersion === '0.0.0') {
        return false
    }
    // Only "behind" counts — a newer runner must not be force-downgraded,
    // including via generationDrift or capability gaps against an older hub offer.
    const versionRelation = typeof version === 'string' && version.length > 0
        ? compareHapiVersions(version, offer.targetVersion)
        : null
    if (versionRelation !== null && versionRelation > 0) {
        return false
    }
    const advertised = new Set(capabilities ?? [])
    const missingCapability = offer.targetCapabilities.some((cap) => !advertised.has(cap))
    const versionBehind = versionRelation !== null && versionRelation < 0
    const generationDrift = !options?.ignoreGenerationDrift
        && offer.channel === 'hub-artifact'
        && typeof offer.targetGeneration === 'string'
        && offer.targetGeneration.length > 0
        && offer.targetGeneration !== (generation ?? '')
    return missingCapability || versionBehind || generationDrift
}

/**
 * Operator-facing fleet-management policy (3-pole switch in Settings):
 * - silent: hub neither alerts nor auto-upgrades drifted runners
 * - alert: hub surfaces the skew banner; operator upgrades manually
 * - auto: hub auto-upgrades drifted runners; banner only for hosts that
 *   cannot auto-upgrade (legacy / handoff-disabled). Success is a toast.
 *
 * Orthogonal to {@link UpgradeChannel}: `HAPI_UPGRADE_CHANNEL=off` is a hard
 * kill (no upgrades at all); this policy governs whether the hub acts/alerts
 * when a channel IS available.
 *
 * Vocabulary: a *machine* is a host record in the hub registry; its *runner*
 * is the daemon (`hapi runner start`) that handles spawn + self-upgrade RPCs.
 * Skew banners list machines whose runners trail the hub offer.
 *
 * Default is `alert`, not `auto`: mutating someone's remote machines without
 * an explicit opt-in is too aggressive for the 99% single-machine case. A
 * dismissible banner is the safe default; multi-machine operators opt into
 * `auto` ("set and forget") in Settings > General > Runner management.
 */
export type FleetUpgradePolicy = 'silent' | 'alert' | 'auto'

export const FLEET_UPGRADE_POLICIES: readonly FleetUpgradePolicy[] = ['silent', 'alert', 'auto']

export const DEFAULT_FLEET_UPGRADE_POLICY: FleetUpgradePolicy = 'alert'

export function isFleetUpgradePolicy(value: unknown): value is FleetUpgradePolicy {
    return typeof value === 'string' && (FLEET_UPGRADE_POLICIES as readonly string[]).includes(value)
}

export type RunnerSelfUpgradeRequest = {
    offer: HubUpgradeOffer
}

export type RunnerSelfUpgradeResponse = {
    status: 'started' | 'already-current' | 'unsupported' | 'failed'
    message: string
    channel?: UpgradeChannel
}
