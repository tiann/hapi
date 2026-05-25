import type { PluginHostInfo, PluginListItem } from '../admin'
import { PluginManifestLiteSchema, pluginManifestRequiresHubInstall, pluginManifestRequiresRunnerInstall, type PluginManifestLite, type PluginRuntimeName } from '../manifest'
import type { PluginMarketplaceEntry, PluginMarketplaceRelease } from '../marketplace'
import { pluginRuntimeCompatibilityProblems } from './compatibility'

export interface ParsedPluginVersion {
    major: number
    minor: number
    patch: number
    prerelease: string[]
    build?: string
}

export interface PluginMarketplaceHostTarget {
    runtime: PluginRuntimeName
    hostInfo?: PluginHostInfo
}

export interface PluginMarketplaceHostContext {
    targets: PluginMarketplaceHostTarget[]
    hostInfos?: PluginHostInfo[]
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function isNumericIdentifier(value: string): boolean {
    return /^\d+$/.test(value)
}

function isValidPrereleaseIdentifier(value: string): boolean {
    if (!value) return false
    if (!/^[0-9A-Za-z-]+$/.test(value)) return false
    return !isNumericIdentifier(value) || value === '0' || !value.startsWith('0')
}

export function parsePluginSemver(version: string): ParsedPluginVersion | null {
    const match = version.trim().match(SEMVER_PATTERN)
    if (!match) return null
    const prerelease = match[4]?.split('.') ?? []
    if (!prerelease.every(isValidPrereleaseIdentifier)) return null
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease,
        ...(match[5] ? { build: match[5] } : {})
    }
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
    const leftNumeric = isNumericIdentifier(left)
    const rightNumeric = isNumericIdentifier(right)
    if (leftNumeric && rightNumeric) {
        const leftNumber = Number(left)
        const rightNumber = Number(right)
        if (leftNumber > rightNumber) return 1
        if (leftNumber < rightNumber) return -1
        return 0
    }
    if (leftNumeric && !rightNumeric) return -1
    if (!leftNumeric && rightNumeric) return 1
    return left.localeCompare(right)
}

function compareParsedPluginVersions(left: ParsedPluginVersion, right: ParsedPluginVersion): number {
    for (const key of ['major', 'minor', 'patch'] as const) {
        if (left[key] > right[key]) return 1
        if (left[key] < right[key]) return -1
    }

    if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
    if (left.prerelease.length === 0) return 1
    if (right.prerelease.length === 0) return -1

    const length = Math.max(left.prerelease.length, right.prerelease.length)
    for (let index = 0; index < length; index += 1) {
        const leftIdentifier = left.prerelease[index]
        const rightIdentifier = right.prerelease[index]
        if (leftIdentifier === undefined) return -1
        if (rightIdentifier === undefined) return 1
        const compared = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier)
        if (compared !== 0) return compared
    }
    return 0
}

export function comparePluginVersions(leftRaw: string, rightRaw: string): number {
    const left = parsePluginSemver(leftRaw)
    const right = parsePluginSemver(rightRaw)
    if (left && right) return compareParsedPluginVersions(left, right)
    if (left && !right) return 1
    if (!left && right) return -1
    return leftRaw.localeCompare(rightRaw)
}

export function sortPluginVersionsDescending<T extends { version: string }>(items: T[]): T[] {
    return [...items].sort((left, right) => comparePluginVersions(right.version, left.version))
}

export function isPluginVersionGreater(left: string, right: string): boolean {
    return comparePluginVersions(left, right) > 0
}

export function installedPluginVersions(plugins: PluginListItem[], pluginId: string): string[] {
    return Array.from(new Set(plugins
        .filter((plugin) => plugin.id === pluginId)
        .map((plugin) => plugin.version)
        .filter((version): version is string => Boolean(version))))
}

function isPluginHostInfo(value: PluginHostInfo | PluginMarketplaceHostTarget): value is PluginHostInfo {
    return 'hapiVersion' in value
}

export function createPluginMarketplaceHostContext(targets: Array<PluginHostInfo | PluginMarketplaceHostTarget | undefined>): PluginMarketplaceHostContext {
    const normalizedTargets = targets
        .filter((target): target is PluginHostInfo | PluginMarketplaceHostTarget => Boolean(target))
        .map((target) => isPluginHostInfo(target)
            ? { runtime: target.runtime, hostInfo: target }
            : target)
    return {
        targets: normalizedTargets,
        hostInfos: normalizedTargets.map((target) => target.hostInfo).filter((hostInfo): hostInfo is PluginHostInfo => Boolean(hostInfo))
    }
}

function supportedReleaseManifest(release: PluginMarketplaceRelease): PluginManifestLite | null {
    const parsed = PluginManifestLiteSchema.safeParse(release.manifest)
    return parsed.success ? parsed.data : null
}

function compatibleHostProblems(manifest: PluginManifestLite, runtime: PluginHostInfo['runtime'], targets: PluginMarketplaceHostTarget[]): string[] {
    const runtimeTargets = targets.filter((target) => target.runtime === runtime)
    if (runtimeTargets.length === 0) {
        return [`No ${runtime} plugin host is available.`]
    }
    const hostProblems = runtimeTargets.map((target) => ({
        target,
        problems: pluginRuntimeCompatibilityProblems(manifest, runtime, target.hostInfo)
    }))
    if (hostProblems.some((entry) => entry.problems.length === 0)) {
        return []
    }
    return [`No ${runtime} plugin host is compatible: ${hostProblems
        .map((entry) => `${entry.target.runtime}${entry.target.hostInfo ? ` ${entry.target.hostInfo.os}/${entry.target.hostInfo.arch}` : ''}: ${entry.problems.join(' ')}`)
        .join(' | ')}`]
}

export function marketplaceReleaseCompatibilityProblems(release: PluginMarketplaceRelease, hostContext: PluginMarketplaceHostContext | undefined): string[] {
    const manifest = supportedReleaseManifest(release)
    if (!manifest) {
        return [`Release ${release.version} uses unsupported pluginApiVersion ${release.manifest.pluginApiVersion}.`]
    }
    if (!hostContext) return []

    const needsRunner = pluginManifestRequiresRunnerInstall(manifest)
    const needsHub = pluginManifestRequiresHubInstall(manifest) || !needsRunner
    return [
        ...(needsHub ? compatibleHostProblems(manifest, 'hub', hostContext.targets) : []),
        ...(needsRunner ? compatibleHostProblems(manifest, 'runner', hostContext.targets) : [])
    ]
}

export function isMarketplaceReleaseCompatible(release: PluginMarketplaceRelease, hostContext: PluginMarketplaceHostContext | undefined): boolean {
    return marketplaceReleaseCompatibilityProblems(release, hostContext).length === 0
}

export function latestCompatibleMarketplaceRelease(entry: PluginMarketplaceEntry, hostContext?: PluginMarketplaceHostContext): PluginMarketplaceRelease | undefined {
    return sortPluginVersionsDescending(entry.releases.filter((release) => !release.yanked && isMarketplaceReleaseCompatible(release, hostContext)))[0]
}
