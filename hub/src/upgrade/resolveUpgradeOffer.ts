import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CURRENT_MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import {
    detectUpgradeChannel,
    NPM_PACKAGE_NAME,
    type HubUpgradeOffer,
    type UpgradeChannel,
} from '@hapi/protocol/upgradeChannel'

export type ResolveUpgradeOfferOptions = {
    envChannel?: string | null
    /** Absolute path to hub package root (directory with hub/package.json). */
    hubPackageRoot: string
    execPath?: string
    /** Override for tests. */
    monorepoRoot?: string | null
    targetVersion?: string
    publicBasePath?: string
    artifact?: HubUpgradeOffer['artifact']
}

/**
 * Walk up from hub package root to find a monorepo that contains cli/ + shared/.
 */
export function findMonorepoRoot(hubPackageRoot: string): string | null {
    let current = resolve(hubPackageRoot)
    for (let i = 0; i < 6; i++) {
        const cliPkg = join(current, 'cli', 'package.json')
        const sharedPkg = join(current, 'shared', 'package.json')
        if (existsSync(cliPkg) && existsSync(sharedPkg)) {
            return current
        }
        const parent = dirname(current)
        if (parent === current) {
            break
        }
        current = parent
    }
    return null
}

export function readCliPackageVersion(monorepoRoot: string): string | null {
    try {
        const raw = readFileSync(join(monorepoRoot, 'cli', 'package.json'), 'utf8')
        const parsed = JSON.parse(raw) as { version?: string }
        return typeof parsed.version === 'string' ? parsed.version : null
    } catch {
        return null
    }
}

function looksLikeNpmHapiPath(path: string): boolean {
    return path.replace(/\\/g, '/').includes('/node_modules/@twsxtd/hapi')
}

/**
 * Resolve what upgrade offer this hub process can make to remotes.
 */
export function resolveUpgradeOffer(options: ResolveUpgradeOfferOptions): HubUpgradeOffer {
    const monorepoRoot = options.monorepoRoot !== undefined
        ? options.monorepoRoot
        : findMonorepoRoot(options.hubPackageRoot)
    const execPath = options.execPath ?? process.execPath
    const cliProjectPath = monorepoRoot ? join(monorepoRoot, 'cli') : options.hubPackageRoot

    let channel: UpgradeChannel = detectUpgradeChannel({
        envChannel: options.envChannel ?? process.env.HAPI_UPGRADE_CHANNEL,
        isCompiled: false,
        execPath,
        projectPath: cliProjectPath,
        monorepoRootExists: Boolean(monorepoRoot),
    })

    // Mixed estates: npm-packaged hub process wins over a sibling checkout on disk.
    if (!options.envChannel && looksLikeNpmHapiPath(execPath)) {
        channel = 'npm'
    }

    const targetVersion = options.targetVersion
        ?? (monorepoRoot ? readCliPackageVersion(monorepoRoot) : null)
        ?? '0.0.0'

    const offer: HubUpgradeOffer = {
        channel,
        targetVersion,
        targetCapabilities: [...CURRENT_MACHINE_CAPABILITIES],
    }

    if (channel === 'npm') {
        offer.npmPackage = NPM_PACKAGE_NAME
    }

    if (channel === 'hub-artifact') {
        offer.artifact = options.artifact ?? {
            url: options.publicBasePath ?? '/cli/upgrade/cli-artifact',
            sha256: '',
            platform: process.platform,
            arch: process.arch,
            sizeBytes: 0,
        }
    }

    return offer
}

/** Default hub package root when running from hub/src/upgrade/... */
export function defaultHubPackageRoot(fromUrl: string = import.meta.url): string {
    return resolve(dirname(fileURLToPath(fromUrl)), '../..')
}
