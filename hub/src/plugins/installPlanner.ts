import type {
    PluginInstallPackageRequest,
    PluginInstallPlanResponse,
    PluginInstallPlanTarget,
    PluginInstallPosition,
    PluginListItem,
    PluginPackageFormat,
    PluginTargetSummary
} from '@hapi/protocol/plugins/admin'
import { pluginManifestRequiresHubInstall, pluginManifestRequiresRunnerInstall, type PluginManifestLite } from '@hapi/protocol/plugins'
import { pluginRuntimeCompatibilityProblems } from '@hapi/protocol/plugins/runtime/compatibility'
import { parsePluginSemver } from '@hapi/protocol/plugins/runtime/versioning'

export interface PluginInstallTargetCandidate {
    target: PluginTargetSummary
    plugins: PluginListItem[]
}

export interface BuildPluginInstallPlanOptions {
    planId: string
    now: number
    expiresAt?: number
    manifest: PluginManifestLite
    request: PluginInstallPackageRequest & {
        runnerSelection?: {
            mode?: 'compatible' | 'all' | 'selected'
            machineIds?: string[]
        }
    }
    packageFormat: PluginPackageFormat
    candidates: PluginInstallTargetCandidate[]
}

export function inferPluginInstallPositions(manifest: PluginManifestLite): PluginInstallPosition[] {
    const capabilities = manifest.capabilities ?? []
    const hasWeb = Boolean(manifest.contributions?.web && Object.values(manifest.contributions.web).some((entry) => Array.isArray(entry) ? entry.length > 0 : Boolean(entry)))
        || capabilities.some((capability) => Boolean(capability.parts.web))
    const hasHub = pluginManifestRequiresHubInstall(manifest)
    const hasRunner = pluginManifestRequiresRunnerInstall(manifest)

    const positions: PluginInstallPosition[] = []
    if (hasWeb) positions.push('web')
    if (hasHub) positions.push('hub')
    if (hasRunner) positions.push('runner')
    return positions.length > 0 ? positions : ['hub']
}

function existingPluginVersion(plugins: PluginListItem[], pluginId: string): string | undefined {
    return plugins.find((plugin) => plugin.id === pluginId)?.version
}

function selectedRunnerMode(options: BuildPluginInstallPlanOptions): 'compatible' | 'all' | 'selected' {
    if (options.request.runnerSelection?.mode) {
        return options.request.runnerSelection.mode
    }
    const placement = options.manifest.install?.runnerPlacement
    if (placement === 'all-runners') return 'all'
    if (placement === 'selected-runners') return 'selected'
    return 'compatible'
}

function createTargetPlan(options: {
    manifest: PluginManifestLite
    candidate: PluginInstallTargetCandidate
    required: boolean
    overwrite: boolean
    compatibleMode: boolean
}): PluginInstallPlanTarget {
    const runtime = options.candidate.target.runtime
    const offline = options.candidate.target.active !== true || Boolean(options.candidate.target.error)
    const existingVersion = existingPluginVersion(options.candidate.plugins, options.manifest.id)
    const incompatibilities = offline
        ? [options.candidate.target.error ?? 'Target is offline.']
        : pluginRuntimeCompatibilityProblems(options.manifest, runtime, options.candidate.target.hostInfo)
    if (incompatibilities.length > 0) {
        const shouldBlock = options.required && !options.compatibleMode
        return {
            target: options.candidate.target,
            runtime,
            required: options.required,
            compatible: false,
            status: offline ? 'offline' : 'incompatible',
            action: shouldBlock ? 'block' : 'skip',
            ...(existingVersion ? { existingVersion } : {}),
            reason: incompatibilities.join(' ')
        }
    }

    if (existingVersion && existingVersion !== options.manifest.version && !options.overwrite) {
        const shouldBlock = options.required && !options.compatibleMode
        return {
            target: options.candidate.target,
            runtime,
            required: options.required,
            compatible: false,
            status: 'conflict',
            action: shouldBlock ? 'block' : 'skip',
            existingVersion,
            reason: `Plugin ${options.manifest.id} ${existingVersion} is already installed. Enable overwrite to replace it with ${options.manifest.version}.`
        }
    }

    return {
        target: options.candidate.target,
        runtime,
        required: options.required,
        compatible: true,
        status: 'compatible',
        action: existingVersion
            ? existingVersion === options.manifest.version ? 'unchanged' : 'overwrite'
            : 'install',
        ...(existingVersion ? { existingVersion } : {})
    }
}

function installTargetLabel(target: PluginTargetSummary): string {
    return target.displayName ?? target.scope
}

type CrossRuntimeVersionSkew = 'none' | 'patch' | 'minor'

function expectedVersionForTarget(manifest: PluginManifestLite, target: PluginInstallPlanTarget): string | undefined {
    if (target.action === 'install' || target.action === 'overwrite') return manifest.version
    if (target.action === 'unchanged') return target.existingVersion ?? manifest.version
    return undefined
}

function crossRuntimeVersionSkew(manifest: PluginManifestLite): CrossRuntimeVersionSkew | undefined {
    const crossRuntime = manifest.compatibility?.crossRuntime
    if (!crossRuntime) return undefined
    if (crossRuntime.samePluginVersionAcrossTargets) return 'none'
    return crossRuntime.allowVersionSkew
}

function versionsWithinAllowedSkew(versions: string[], skew: CrossRuntimeVersionSkew): boolean {
    if (versions.length <= 1) return true
    if (skew === 'none') return versions.every((version) => version === versions[0])
    const parsed = versions.map((version) => ({ version, parsed: parsePluginSemver(version) }))
    if (parsed.some((entry) => !entry.parsed)) {
        return versions.every((version) => version === versions[0])
    }
    const first = parsed[0]!.parsed!
    return parsed.every(({ parsed: current }) => {
        if (!current) return false
        if (current.major !== first.major) return false
        if (skew === 'minor') return true
        if (current.minor !== first.minor) return false
        return true
    })
}

function crossRuntimePolicyLabel(manifest: PluginManifestLite, skew: CrossRuntimeVersionSkew): string {
    if (manifest.compatibility?.crossRuntime?.samePluginVersionAcrossTargets) {
        return 'samePluginVersionAcrossTargets'
    }
    return `allowVersionSkew=${skew}`
}

export function validateCrossRuntimeVersionPlan(args: {
    manifest: PluginManifestLite
    targets: PluginInstallPlanTarget[]
    candidates: PluginInstallTargetCandidate[]
    overwrite: boolean
}): string[] {
    const skew = crossRuntimeVersionSkew(args.manifest)
    if (!skew) return []

    const ready = args.targets
        .map((target) => ({
            target,
            version: expectedVersionForTarget(args.manifest, target)
        }))
        .filter((entry): entry is { target: PluginInstallPlanTarget; version: string } =>
            Boolean(entry.version)
            && entry.target.compatible
            && (entry.target.action === 'install' || entry.target.action === 'overwrite' || entry.target.action === 'unchanged'))

    const versions = Array.from(new Set(ready.map((entry) => entry.version)))
    if (versionsWithinAllowedSkew(versions, skew)) return []

    const versionSummary = ready
        .map((entry) => `${installTargetLabel(entry.target.target)}=${entry.version}`)
        .join(', ')
    return [`Plugin declares ${crossRuntimePolicyLabel(args.manifest, skew)}; planned ready targets would use multiple versions (${versionSummary}). Enable overwrite or select fewer runners.`]
}

function crossRuntimeVersionWarnings(manifest: PluginManifestLite, targets: PluginInstallPlanTarget[]): string[] {
    const warnings: string[] = []
    const skew = crossRuntimeVersionSkew(manifest)
    const readyTargets = targets.filter((target) => target.compatible && (target.action === 'install' || target.action === 'overwrite' || target.action === 'unchanged'))
    const readyLabel = readyTargets.length > 0
        ? `${readyTargets.map((target) => installTargetLabel(target.target)).join(' + ')} will use ${manifest.version}`
        : `new installs would use ${manifest.version}`
    for (const target of targets) {
        if (target.action !== 'skip' || target.status !== 'conflict' || !target.existingVersion) continue
        const policy = skew ? ` Plugin declares ${crossRuntimePolicyLabel(manifest, skew)}; enable overwrite or select fewer runners if this skew is not intended.` : ''
        warnings.push(`${installTargetLabel(target.target)} has plugin ${target.existingVersion} and will be skipped; ${readyLabel}.${policy}`)
    }
    return warnings
}

function networkPermissionWarnings(manifest: PluginManifestLite): string[] {
    const declarations = manifest.permissions?.network ?? []
    if (declarations.length === 0) return []

    const warnings = [
        `Plugin declares network access through ctx.network.fetch: ${declarations.join(', ')}. This is a basic SDK check, not a sandbox; install only trusted code.`
    ]
    const broadDeclarations = declarations.filter(isBroadNetworkDeclaration)
    if (broadDeclarations.length > 0) {
        warnings.push(`Plugin declares wildcard or broad network targets: ${broadDeclarations.join(', ')}. Review them before installing.`)
    }
    return warnings
}

function isBroadNetworkDeclaration(value: string): boolean {
    const trimmed = value.trim().toLowerCase()
    if (!trimmed) return false
    if (trimmed === '*' || trimmed.startsWith('*://')) return true
    try {
        const url = new URL(trimmed)
        return url.hostname.includes('*')
    } catch {
        return trimmed.includes('*')
    }
}

export function buildPluginInstallPlan(options: BuildPluginInstallPlanOptions): PluginInstallPlanResponse {
    const positions = inferPluginInstallPositions(options.manifest)
    const needsHub = positions.includes('hub')
    const needsRunner = positions.includes('runner')
    const runnerMode = selectedRunnerMode(options)
    const selectedRunnerIds = new Set(options.request.runnerSelection?.machineIds ?? [])
    const compatibleMode = runnerMode === 'compatible'
    const offlineRunnerPolicy = options.manifest.install?.offlineRunnerPolicy ?? 'skip'
    const targets: PluginInstallPlanTarget[] = []
    const warnings: string[] = networkPermissionWarnings(options.manifest)
    const blockingErrors: string[] = []

    const hubCandidate = options.candidates.find((candidate) => candidate.target.runtime === 'hub')
    if (needsHub) {
        if (!hubCandidate) {
            blockingErrors.push('Plugin requires Hub installation, but Hub target was not available.')
        } else {
            targets.push(createTargetPlan({
                manifest: options.manifest,
                candidate: hubCandidate,
                required: true,
                overwrite: options.request.overwrite === true,
                compatibleMode: false
            }))
        }
    }

    const runnerCandidates = options.candidates
        .filter((candidate) => candidate.target.runtime === 'runner')
        .filter((candidate) => runnerMode !== 'selected' || (candidate.target.machineId ? selectedRunnerIds.has(candidate.target.machineId) : false))

    if (needsRunner) {
        if (runnerMode === 'selected' && selectedRunnerIds.size === 0) {
            warnings.push('Plugin suggests selected Runner placement, but no Runner was selected. Showing no Runner install target until selection is provided.')
        }
        if (runnerMode === 'selected') {
            const present = new Set(runnerCandidates.map((candidate) => candidate.target.machineId).filter((entry): entry is string => Boolean(entry)))
            for (const machineId of selectedRunnerIds) {
                if (!present.has(machineId)) {
                    blockingErrors.push(`Selected Runner ${machineId} was not found.`)
                }
            }
        }

        for (const candidate of runnerCandidates) {
            const required = runnerMode !== 'compatible'
            const targetPlan = createTargetPlan({
                manifest: options.manifest,
                candidate,
                required,
                overwrite: options.request.overwrite === true,
                compatibleMode
            })
            if (targetPlan.status === 'offline' && offlineRunnerPolicy === 'fail') {
                targets.push({ ...targetPlan, required: true, action: 'block' })
            } else {
                targets.push(targetPlan)
            }
        }

        const readyRunnerTargets = targets.filter((target) =>
            target.runtime === 'runner'
            && target.compatible
            && (target.action === 'install' || target.action === 'overwrite' || target.action === 'unchanged'))
        const minReadyRunnerCount = options.manifest.install?.minReadyRunnerCount ?? (needsRunner ? 1 : 0)
        if (readyRunnerTargets.length < minReadyRunnerCount) {
            const explicitTargetBlockers = targets.filter((target) => target.action === 'block' && target.reason)
            const skippedRunnerConflicts = targets.filter((target) =>
                target.runtime === 'runner'
                && target.status === 'conflict'
                && target.action === 'skip'
                && target.reason)
            if (explicitTargetBlockers.length === 0 && skippedRunnerConflicts.length > 0) {
                for (const target of skippedRunnerConflicts) {
                    blockingErrors.push(`${installTargetLabel(target.target)}: ${target.reason}`)
                }
            } else if (explicitTargetBlockers.length === 0) {
                blockingErrors.push(`Plugin requires at least ${minReadyRunnerCount} compatible Runner target(s), but only ${readyRunnerTargets.length} are ready.`)
            }
        }
        if (runnerCandidates.length === 0 && minReadyRunnerCount > 0) {
            blockingErrors.push('Plugin requires Runner installation, but no Runner target was available.')
        }
        if (runnerMode === 'all' && targets.some((target) => target.runtime === 'runner' && !target.compatible)) {
            blockingErrors.push('Plugin requested all Runner placement, but at least one Runner target is not installable.')
        }
    }

    for (const target of targets) {
        if (target.action === 'block' && target.reason) {
            blockingErrors.push(`${installTargetLabel(target.target)}: ${target.reason}`)
        }
    }

    warnings.push(...crossRuntimeVersionWarnings(options.manifest, targets))
    blockingErrors.push(...validateCrossRuntimeVersionPlan({
        manifest: options.manifest,
        targets,
        candidates: options.candidates,
        overwrite: options.request.overwrite === true
    }))

    return {
        planId: options.planId,
        createdAt: options.now,
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
        plugin: {
            id: options.manifest.id,
            name: options.manifest.name,
            version: options.manifest.version,
            ...(options.manifest.description ? { description: options.manifest.description } : {}),
            ...(options.manifest.display ? { display: options.manifest.display } : {})
        },
        source: {
            type: options.request.installSource?.type === 'marketplace'
                ? options.request.installSource.distribution === 'hapi-source' ? 'marketplace-source' : 'marketplace-package'
                : 'uploaded-package',
            filename: options.request.filename,
            checksum: options.request.checksum,
            format: options.packageFormat,
            ...(options.request.installSource?.assetUrl ? { assetUrl: options.request.installSource.assetUrl } : {}),
            ...(options.request.installSource?.sourcePath ? { sourcePath: options.request.installSource.sourcePath } : {})
        },
        positions,
        targets,
        warnings,
        blockingErrors: Array.from(new Set(blockingErrors))
    }
}
