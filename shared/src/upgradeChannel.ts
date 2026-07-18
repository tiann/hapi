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
    if (!raw) {
        return null
    }
    const value = raw.trim().toLowerCase()
    if (value === 'npm' || value === 'hub-artifact' || value === 'off') {
        return value
    }
    return null
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

export type RunnerSelfUpgradeRequest = {
    offer: HubUpgradeOffer
}

export type RunnerSelfUpgradeResponse = {
    status: 'started' | 'already-current' | 'unsupported' | 'failed'
    message: string
    channel?: UpgradeChannel
}
