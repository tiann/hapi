#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
    HAPI_PLUGIN_API_VERSION,
    HAPI_PLUGIN_MANIFEST_FILE,
    type PluginDiagnostic,
    type PluginManifestLite
} from '@hapi/protocol/plugins'
import { validatePluginRoot } from '@hapi/protocol/plugins/foundation'
import { HUB_IMPLEMENTED_EXTENSION_POINTS, RUNNER_IMPLEMENTED_EXTENSION_POINTS } from '@hapi/protocol/plugins/extensionPoints'
import { satisfiesVersionRange } from '@hapi/protocol/plugins/runtime/compatibility'

const repoRoot = join(import.meta.dir, '..')
const pluginsRoot = join(repoRoot, 'plugins')

type ValidationIssue = PluginDiagnostic & { path?: string }
type CapabilityPartName = 'web' | 'hub' | 'runner'

type ContributionLookup = {
    path: string
    ids(manifest: PluginManifestLite): string[]
}

export interface ValidatePluginArgs {
    pluginDir: string
    json: boolean
}

export interface PluginValidationResult {
    ok: boolean
    pluginId?: string
    pluginDir: string
    errors: number
    warnings: number
    diagnostics: ValidationIssue[]
}

const capabilityContributionLookups: Record<CapabilityPartName, Record<string, ContributionLookup>> = {
    web: {
        settingsPanel: {
            path: 'contributions.web.settingsPanels',
            ids: (manifest) => (manifest.contributions?.web?.settingsPanels ?? []).map((entry) => entry.id)
        },
        newSessionField: {
            path: 'contributions.web.newSessionFields',
            ids: (manifest) => (manifest.contributions?.web?.newSessionFields ?? []).map((entry) => entry.id)
        },
        action: {
            path: 'contributions.web.actions',
            ids: (manifest) => (manifest.contributions?.web?.actions ?? []).map((entry) => entry.id)
        },
        badge: {
            path: 'contributions.web.badges',
            ids: (manifest) => (manifest.contributions?.web?.badges ?? []).map((entry) => entry.id)
        },
        composerAction: {
            path: 'contributions.web.composerActions',
            ids: (manifest) => (manifest.contributions?.web?.composerActions ?? []).map((entry) => entry.id)
        }
    },
    hub: {
        notificationChannel: {
            path: 'contributions.hub.notificationChannels',
            ids: (manifest) => (manifest.contributions?.hub?.notificationChannels ?? []).map((entry) => entry.id)
        },
        messageAction: {
            path: 'contributions.hub.messageActions',
            ids: (manifest) => (manifest.contributions?.hub?.messageActions ?? []).map((entry) => entry.id)
        }
    },
    runner: {
        spawnOptionsProvider: {
            path: 'contributions.runner.spawnOptionsProviders',
            ids: (manifest) => (manifest.contributions?.runner?.spawnOptionsProviders ?? []).map((entry) => entry.id)
        },
        environmentProvider: {
            path: 'contributions.runner.environmentProviders',
            ids: (manifest) => (manifest.contributions?.runner?.environmentProviders ?? []).map((entry) => entry.id)
        },
        commandResolver: {
            path: 'contributions.runner.commandResolvers',
            ids: (manifest) => (manifest.contributions?.runner?.commandResolvers ?? []).map((entry) => entry.id)
        },
        spawnHook: {
            path: 'contributions.runner.spawnHooks',
            ids: (manifest) => (manifest.contributions?.runner?.spawnHooks ?? []).map((entry) => entry.id)
        },
        agentAdapter: {
            path: 'contributions.agent.adapters',
            ids: (manifest) => (manifest.contributions?.agent?.adapters ?? []).map((entry) => entry.id)
        },
        agentCapabilityProvider: {
            path: 'contributions.agent.capabilityProviders',
            ids: (manifest) => (manifest.contributions?.agent?.capabilityProviders ?? []).map((entry) => entry.id)
        }
    }
}

function usage(): string {
    return 'Usage: bun scripts/validate-plugin.ts <plugin-dir> [--json]'
}

function toPosix(path: string): string {
    return path.split(sep).join('/')
}

function isInside(parent: string, child: string): boolean {
    const rel = relative(parent, child)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

function issue(severity: ValidationIssue['severity'], code: string, message: string, path?: string): ValidationIssue {
    return { severity, code, message, ...(path ? { path } : {}) }
}

function recommendedUpperBound(pluginApiVersion: string): string {
    const [majorRaw, minorRaw] = pluginApiVersion.split('.')
    const major = Number(majorRaw)
    const minor = Number(minorRaw)
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return `>${pluginApiVersion}`
    return `<${major}.${minor + 1}`
}

function validateCapabilityContributionReferences(manifest: PluginManifestLite, manifestPath: string): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    for (const capability of manifest.capabilities ?? []) {
        for (const partName of ['web', 'hub', 'runner'] as const) {
            const part = capability.parts[partName]
            if (!part) continue
            const lookups = capabilityContributionLookups[partName]
            for (const contribution of part.contributions) {
                const lookup = lookups[contribution.type]
                if (!lookup) {
                    issues.push(issue(
                        'warning',
                        'unknown-capability-contribution-type',
                        `Capability ${capability.id} references ${partName}.${contribution.type}:${contribution.id}, but validate-plugin does not know how to verify that contribution type yet.`,
                        manifestPath
                    ))
                    continue
                }
                const declaredIds = new Set(lookup.ids(manifest))
                if (!declaredIds.has(contribution.id)) {
                    issues.push(issue(
                        'error',
                        'capability-contribution-missing',
                        `Capability ${capability.id} references ${partName}.${contribution.type}:${contribution.id}, but it is not declared in ${lookup.path}.`,
                        manifestPath
                    ))
                }
            }
        }
    }
    return issues
}

function validateExtensionPointNames(manifest: PluginManifestLite, manifestPath: string): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    const runtimeExtensionPoints = {
        hub: new Set<string>(HUB_IMPLEMENTED_EXTENSION_POINTS),
        runner: new Set<string>(RUNNER_IMPLEMENTED_EXTENSION_POINTS)
    } satisfies Record<'hub' | 'runner', Set<string>>

    for (const runtime of ['hub', 'runner'] as const) {
        const declared = runtime === 'hub'
            ? manifest.compatibility?.hub?.extensionPoints ?? []
            : manifest.compatibility?.runner?.extensionPoints ?? []
        const supported = runtimeExtensionPoints[runtime]
        for (const extensionPoint of declared) {
            if (!supported.has(extensionPoint)) {
                issues.push(issue(
                    'warning',
                    'unknown-extension-point',
                    `${runtime} extension point "${extensionPoint}" is not currently advertised by this checkout.`,
                    manifestPath
                ))
            }
        }
    }
    return issues
}

function additionalManifestChecks(manifest: PluginManifestLite, pluginRoot: string): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    const manifestPath = join(pluginRoot, HAPI_PLUGIN_MANIFEST_FILE)
    const pluginApiRange = manifest.compatibility?.pluginApi
    const recommendedRange = `>=${manifest.pluginApiVersion} ${recommendedUpperBound(manifest.pluginApiVersion)}`

    if (!pluginApiRange) {
        issues.push(issue('warning', 'missing-plugin-api-range', `Recommended compatibility.pluginApi range is missing. Use "${recommendedRange}" for first-party plugins.`, manifestPath))
    } else if (!satisfiesVersionRange(manifest.pluginApiVersion, pluginApiRange)) {
        issues.push(issue('error', 'plugin-api-range-excludes-contract', `compatibility.pluginApi (${pluginApiRange}) does not include pluginApiVersion ${manifest.pluginApiVersion}.`, manifestPath))
    }

    for (const declaration of manifest.permissions?.network ?? []) {
        const normalized = declaration.trim().toLowerCase()
        if (normalized === '*' || normalized.includes('*')) {
            issues.push(issue('warning', 'broad-network-permission', `Network permission "${declaration}" is broad; review trusted-code risk before shipping.`, manifestPath))
        }
    }

    issues.push(...validateCapabilityContributionReferences(manifest, manifestPath))
    issues.push(...validateExtensionPointNames(manifest, manifestPath))

    if (isInside(pluginsRoot, pluginRoot) && !existsSync(join(pluginRoot, 'hapi.marketplace.json'))) {
        issues.push(issue('error', 'missing-marketplace-metadata', 'First-party plugins under plugins/ must include hapi.marketplace.json.', pluginRoot))
    }

    return issues
}

function printIssue(diagnostic: ValidationIssue): void {
    const prefix = diagnostic.severity.toUpperCase()
    console.log(`${prefix} ${diagnostic.code}: ${diagnostic.message}`)
    if (diagnostic.path) {
        console.log(`  ${toPosix(relative(repoRoot, diagnostic.path))}`)
    }
}

export function parseValidatePluginArgs(args: string[]): ValidatePluginArgs {
    let pluginDir: string | undefined
    let json = false
    for (const arg of args) {
        if (arg === '--') continue
        if (arg === '--json') {
            json = true
            continue
        }
        if (arg.startsWith('-')) {
            throw new Error(`${usage()}\nUnknown option: ${arg}`)
        }
        if (pluginDir) {
            throw new Error(`${usage()}\nUnexpected argument: ${arg}`)
        }
        pluginDir = arg
    }
    if (!pluginDir) throw new Error(usage())
    return { pluginDir, json }
}

export async function validatePluginDirectory(pluginDir: string): Promise<PluginValidationResult> {
    const pluginRoot = resolve(pluginDir)
    const record = await validatePluginRoot(pluginRoot, isInside(pluginsRoot, pluginRoot) ? 'bundled' : 'user-home')
    const diagnostics: ValidationIssue[] = [...record.diagnostics]
    if (record.manifest) {
        diagnostics.push(...additionalManifestChecks(record.manifest, pluginRoot))
    }

    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
    const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length
    return {
        ok: errors === 0,
        ...(record.manifest?.id ? { pluginId: record.manifest.id } : {}),
        pluginDir: pluginRoot,
        errors,
        warnings,
        diagnostics
    }
}

export async function runValidatePluginCli(args: string[] = process.argv.slice(2)): Promise<number> {
    let parsed: ValidatePluginArgs
    try {
        parsed = parseValidatePluginArgs(args)
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        return 2
    }

    const result = await validatePluginDirectory(parsed.pluginDir)
    if (parsed.json) {
        console.log(JSON.stringify(result, null, 4))
    } else {
        for (const diagnostic of result.diagnostics) {
            printIssue(diagnostic)
        }
        if (!result.ok) {
            console.error(`[validate-plugin] failed: ${result.errors} error(s), ${result.warnings} warning(s).`)
        } else {
            console.log(`[validate-plugin] OK: ${result.pluginId ?? toPosix(relative(repoRoot, result.pluginDir))} (${result.warnings} warning(s)).`)
        }
    }

    return result.ok ? 0 : 1
}

if (import.meta.main) {
    const exitCode = await runValidatePluginCli()
    process.exit(exitCode)
}
