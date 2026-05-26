import { describe, expect, it } from 'bun:test'
import { HAPI_PLUGIN_API_VERSION, type PluginManifestLite } from '@hapi/protocol/plugins'
import {
    HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID,
    HAPI_SCHEDULE_SEND_PLUGIN_ID,
    bundledFirstPartyPlugins
} from '@hapi/protocol/plugins/bundledCore'
import { HUB_IMPLEMENTED_EXTENSION_POINTS, RUNNER_IMPLEMENTED_EXTENSION_POINTS } from '@hapi/protocol/plugins/extensionPoints'
import { buildPluginInstallPlan, inferPluginInstallPositions, validateCrossRuntimeVersionPlan } from './installPlanner'
import type { PluginInstallTargetCandidate } from './installPlanner'

function manifest(overrides: Partial<PluginManifestLite> = {}): PluginManifestLite {
    return {
        id: 'com.example.plugin',
        name: 'Example',
        version: '1.0.0',
        pluginApiVersion: HAPI_PLUGIN_API_VERSION,
        ...overrides
    }
}

const CURRENT_HUB_EXTENSION_POINTS = [...HUB_IMPLEMENTED_EXTENSION_POINTS]
const CURRENT_RUNNER_EXTENSION_POINTS = [...RUNNER_IMPLEMENTED_EXTENSION_POINTS]

function firstPartyPluginManifest(id: string): PluginManifestLite {
    const plugin = bundledFirstPartyPlugins.find((entry) => entry.manifest.id === id)
    if (!plugin) throw new Error(`Missing bundled first-party plugin ${id}`)
    return plugin.manifest
}

function hubCandidate(
    plugins: PluginInstallTargetCandidate['plugins'] = [],
    options: { supportedExtensionPoints?: string[] } = {}
): PluginInstallTargetCandidate {
    return {
        target: {
            scope: 'hub',
            runtime: 'hub',
            active: true,
            hostInfo: {
                runtime: 'hub',
                hapiVersion: '0.18.4',
                pluginApiVersion: HAPI_PLUGIN_API_VERSION,
                os: 'linux',
                arch: 'x64',
                supportedExtensionPoints: options.supportedExtensionPoints ?? ['hub.messageAction', 'web.composerAction']
            }
        },
        plugins
    }
}

function runnerCandidate(machineId: string, options: {
    hapiVersion?: string
    active?: boolean
    plugins?: PluginInstallTargetCandidate['plugins']
    supportedExtensionPoints?: string[]
} = {}): PluginInstallTargetCandidate {
    return {
        target: {
            scope: `runner:${machineId}`,
            runtime: 'runner',
            machineId,
            active: options.active ?? true,
            ...(options.active === false ? { error: 'Runner is offline.' } : {}),
            hostInfo: {
                runtime: 'runner',
                hapiVersion: options.hapiVersion ?? '0.18.4',
                pluginApiVersion: HAPI_PLUGIN_API_VERSION,
                os: 'linux',
                arch: 'x64',
                supportedExtensionPoints: options.supportedExtensionPoints ?? ['runner.spawnHook', 'agent.capabilityProvider']
            }
        },
        plugins: options.plugins ?? []
    }
}

function planFor(
    manifestValue: PluginManifestLite,
    candidates: PluginInstallTargetCandidate[],
    requestOverrides: Record<string, unknown> = {}
) {
    return buildPluginInstallPlan({
        planId: 'plan-1',
        now: 1,
        manifest: manifestValue,
        request: {
            filename: 'plugin.tgz',
            contentBase64: 'AA==',
            checksum: 'sha256:test',
            format: 'tgz',
            ...requestOverrides
        },
        packageFormat: 'tgz',
        candidates
    })
}

describe('plugin install planner', () => {
    it('plans all bundled first-party plugin manifests against current Hub and Runner extension points', () => {
        const candidates = [
            hubCandidate([], { supportedExtensionPoints: CURRENT_HUB_EXTENSION_POINTS }),
            runnerCandidate('runner-current', { supportedExtensionPoints: CURRENT_RUNNER_EXTENSION_POINTS })
        ]

        for (const plugin of bundledFirstPartyPlugins) {
            const plan = planFor(plugin.manifest, candidates)
            expect({ pluginId: plugin.manifest.id, blockingErrors: plan.blockingErrors }).toEqual({ pluginId: plugin.manifest.id, blockingErrors: [] })
            expect({ pluginId: plugin.manifest.id, allTargetsCompatible: plan.targets.every((target) => target.status === 'compatible') }).toEqual({ pluginId: plugin.manifest.id, allTargetsCompatible: true })
        }
    })

    it('marks Schedule Send incompatible without required Hub/Web extension points', () => {
        const plan = planFor(
            firstPartyPluginManifest(HAPI_SCHEDULE_SEND_PLUGIN_ID),
            [hubCandidate([], { supportedExtensionPoints: ['web.settingsPanel'] })]
        )

        expect(plan.targets[0]?.status).toBe('incompatible')
        expect(plan.targets[0]?.action).toBe('block')
        expect(plan.targets[0]?.reason).toContain('hub.messageAction')
        expect(plan.targets[0]?.reason).toContain('web.composerAction')
    })

    it('marks Runner Launch Presets incompatible without its Hub settings panel or Runner spawn defaults extension point', () => {
        const plugin = firstPartyPluginManifest(HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID)
        const missingHubPanel = planFor(plugin, [
            hubCandidate([], { supportedExtensionPoints: ['hub.messageAction'] }),
            runnerCandidate('runner-current', { supportedExtensionPoints: CURRENT_RUNNER_EXTENSION_POINTS })
        ])
        expect(missingHubPanel.targets.find((target) => target.target.scope === 'hub')?.status).toBe('incompatible')
        expect(missingHubPanel.targets.find((target) => target.target.scope === 'hub')?.action).toBe('block')
        expect(missingHubPanel.blockingErrors.join(' ')).toContain('web.settingsPanel')

        const missingRunnerProvider = planFor(plugin, [
            hubCandidate([], { supportedExtensionPoints: CURRENT_HUB_EXTENSION_POINTS }),
            runnerCandidate('runner-missing', { supportedExtensionPoints: ['runner.spawnHook'] })
        ])
        const runnerTarget = missingRunnerProvider.targets.find((target) => target.target.scope === 'runner:runner-missing')
        expect(runnerTarget?.status).toBe('incompatible')
        expect(runnerTarget?.action).toBe('skip')
        expect(runnerTarget?.reason).toContain('runner.spawnOptionsProvider')
        expect(missingRunnerProvider.blockingErrors).toContain('Plugin requires at least 1 compatible Runner target(s), but only 0 are ready.')
    })

    it('routes Web-only descriptors through Hub installation', () => {
        const plugin = manifest({
            contributions: {
                web: {
                    composerActions: [{
                        id: 'schedule',
                        kind: 'pluginMessageAction',
                        label: 'Schedule',
                        icon: 'clock',
                        handler: { position: 'hub', actionId: 'schedule.send' },
                        ui: { kind: 'button' }
                    }]
                }
            }
        })

        expect(inferPluginInstallPositions(plugin)).toEqual(['web', 'hub'])
        const plan = planFor(plugin, [hubCandidate(), runnerCandidate('runner-1')])
        expect(plan.positions).toEqual(['web', 'hub'])
        expect(plan.targets.map((target) => target.target.scope)).toEqual(['hub'])
        expect(plan.blockingErrors).toEqual([])
    })

    it('plans Hub plus compatible Runner targets and skips incompatible Runner versions', () => {
        const plugin = manifest({
            runtimes: {
                hub: { entry: 'hub.js' },
                runner: { entry: 'runner.js' }
            },
            compatibility: {
                runner: { hapi: '>=0.18.4' }
            }
        })

        const plan = planFor(plugin, [
            hubCandidate(),
            runnerCandidate('runner-ok', { hapiVersion: '0.18.4' }),
            runnerCandidate('runner-old', { hapiVersion: '0.17.0' })
        ])

        expect(plan.positions).toEqual(['hub', 'runner'])
        expect(plan.targets.find((target) => target.target.scope === 'runner:runner-ok')?.action).toBe('install')
        expect(plan.targets.find((target) => target.target.scope === 'runner:runner-old')?.action).toBe('skip')
        expect(plan.blockingErrors).toEqual([])
    })

    it('blocks Runner-only installs when no compatible Runner is ready', () => {
        const plugin = manifest({
            runtimes: { runner: { entry: 'runner.js' } },
            compatibility: {
                runner: { hapi: '>=0.18.4' }
            }
        })

        const plan = planFor(plugin, [hubCandidate(), runnerCandidate('runner-old', { hapiVersion: '0.17.0' })])

        expect(plan.positions).toEqual(['runner'])
        expect(plan.blockingErrors).toContain('Plugin requires at least 1 compatible Runner target(s), but only 0 are ready.')
    })

    it('honors selected Runner placement and blocks missing selected targets', () => {
        const plugin = manifest({
            runtimes: { runner: { entry: 'runner.js' } },
            install: { runnerPlacement: 'selected-runners' }
        })

        const plan = planFor(plugin, [
            runnerCandidate('runner-a'),
            runnerCandidate('runner-b')
        ], {
            runnerSelection: { mode: 'selected', machineIds: ['runner-b', 'runner-missing'] }
        })

        expect(plan.targets.map((target) => target.target.scope)).toEqual(['runner:runner-b'])
        expect(plan.blockingErrors).toContain('Selected Runner runner-missing was not found.')
    })

    it('blocks all-runner placement when any runner is offline', () => {
        const plugin = manifest({
            runtimes: { runner: { entry: 'runner.js' } },
            install: { runnerPlacement: 'all-runners' }
        })

        const plan = planFor(plugin, [
            runnerCandidate('runner-online'),
            runnerCandidate('runner-offline', { active: false })
        ])

        expect(plan.targets.find((target) => target.target.scope === 'runner:runner-offline')?.status).toBe('offline')
        expect(plan.blockingErrors).toContain('Plugin requested all Runner placement, but at least one Runner target is not installable.')
    })

    it('blocks offline runners when offlineRunnerPolicy is fail', () => {
        const plugin = manifest({
            runtimes: { runner: { entry: 'runner.js' } },
            install: { offlineRunnerPolicy: 'fail' }
        })

        const plan = planFor(plugin, [runnerCandidate('runner-offline', { active: false })])

        expect(plan.targets[0]).toMatchObject({ status: 'offline', action: 'block', required: true })
        expect(plan.blockingErrors.join(' ')).toContain('Runner is offline')
    })

    it('reports installed-version conflicts and allows overwrite', () => {
        const plugin = manifest({ runtimes: { hub: { entry: 'hub.js' } }, version: '2.0.0' })
        const installed = [{ ...({} as PluginInstallTargetCandidate['plugins'][number]), id: plugin.id, version: '1.0.0' }]

        const blocked = planFor(plugin, [hubCandidate(installed)])
        const overwrite = planFor(plugin, [hubCandidate(installed)], { overwrite: true })

        expect(blocked.targets[0]).toMatchObject({ status: 'conflict', action: 'block', existingVersion: '1.0.0' })
        expect(overwrite.targets[0]).toMatchObject({ status: 'compatible', action: 'overwrite', existingVersion: '1.0.0' })
    })

    it('warns when plugins declare network access', () => {
        const plugin = manifest({
            runtimes: { hub: { entry: 'hub.js' } },
            permissions: { network: ['https://api.example.com'] }
        })

        const plan = planFor(plugin, [hubCandidate()])

        expect(plan.warnings).toEqual([
            'Plugin declares network access through ctx.network.fetch: https://api.example.com. This is a basic SDK check, not a sandbox; install only trusted code.'
        ])
    })

    it('adds an extra warning for wildcard network targets', () => {
        const plugin = manifest({
            runtimes: { hub: { entry: 'hub.js' } },
            permissions: { network: ['https://*.example.com'] }
        })

        const plan = planFor(plugin, [hubCandidate()])

        expect(plan.warnings).toEqual([
            'Plugin declares network access through ctx.network.fetch: https://*.example.com. This is a basic SDK check, not a sandbox; install only trusted code.',
            'Plugin declares wildcard or broad network targets: https://*.example.com. Review them before installing.'
        ])
    })

    it('does not add generic Runner readiness errors when a required target already explains the conflict', () => {
        const plugin = manifest({
            version: '1.0.0',
            runtimes: {
                hub: { entry: 'hub.js' },
                runner: { entry: 'runner.js' }
            }
        })
        const installed = [{ ...({} as PluginInstallTargetCandidate['plugins'][number]), id: plugin.id, version: '2.0.0' }]

        const plan = planFor(plugin, [
            hubCandidate(installed),
            runnerCandidate('runner-current', { plugins: installed })
        ])

        expect(plan.targets.find((target) => target.target.scope === 'hub')).toMatchObject({ status: 'conflict', action: 'block' })
        expect(plan.targets.find((target) => target.target.scope === 'runner:runner-current')).toMatchObject({ status: 'conflict', action: 'skip' })
        expect(plan.blockingErrors).toContain('hub: Plugin com.example.plugin 2.0.0 is already installed. Enable overwrite to replace it with 1.0.0.')
        expect(plan.blockingErrors).not.toContain('Plugin requires at least 1 compatible Runner target(s), but only 0 are ready.')
    })

    it('reports Runner version conflicts instead of a generic readiness error when Runner is the only required position', () => {
        const plugin = manifest({
            version: '1.0.0',
            runtimes: { runner: { entry: 'runner.js' } }
        })
        const installed = [{ ...({} as PluginInstallTargetCandidate['plugins'][number]), id: plugin.id, version: '2.0.0' }]

        const plan = planFor(plugin, [
            runnerCandidate('runner-current', { plugins: installed })
        ])

        expect(plan.targets[0]).toMatchObject({ status: 'conflict', action: 'skip' })
        expect(plan.blockingErrors).toContain('runner:runner-current: Plugin com.example.plugin 2.0.0 is already installed. Enable overwrite to replace it with 1.0.0.')
        expect(plan.blockingErrors).not.toContain('Plugin requires at least 1 compatible Runner target(s), but only 0 are ready.')
    })

    it('enforces minReadyRunnerCount greater than one', () => {
        const plugin = manifest({
            runtimes: { runner: { entry: 'runner.js' } },
            install: { minReadyRunnerCount: 2 }
        })

        const plan = planFor(plugin, [
            runnerCandidate('runner-ready'),
            runnerCandidate('runner-offline', { active: false })
        ])

        expect(plan.blockingErrors).toContain('Plugin requires at least 2 compatible Runner target(s), but only 1 are ready.')
    })

    it('warns when compatible Runner placement skips an older installed version while another target updates', () => {
        const plugin = manifest({
            version: '1.1.0',
            runtimes: {
                hub: { entry: 'hub.js' },
                runner: { entry: 'runner.js' }
            },
            compatibility: {
                crossRuntime: { samePluginVersionAcrossTargets: true }
            }
        })
        const installedOld = [{ ...({} as PluginInstallTargetCandidate['plugins'][number]), id: plugin.id, version: '1.0.0' }]

        const plan = planFor(plugin, [
            hubCandidate(),
            runnerCandidate('runner-ready'),
            runnerCandidate('runner-old', { plugins: installedOld })
        ])

        expect(plan.targets.find((target) => target.target.scope === 'runner:runner-old')).toMatchObject({ status: 'conflict', action: 'skip' })
        expect(plan.blockingErrors).toEqual([])
        expect(plan.warnings.join(' ')).toContain('runner:runner-old has plugin 1.0.0 and will be skipped')
        expect(plan.warnings.join(' ')).toContain('samePluginVersionAcrossTargets')
    })

    it('overwrites all old targets when requested for same-version cross-runtime plugins', () => {
        const plugin = manifest({
            version: '1.1.0',
            runtimes: {
                hub: { entry: 'hub.js' },
                runner: { entry: 'runner.js' }
            },
            compatibility: {
                crossRuntime: { samePluginVersionAcrossTargets: true }
            }
        })
        const installedOld = [{ ...({} as PluginInstallTargetCandidate['plugins'][number]), id: plugin.id, version: '1.0.0' }]

        const plan = planFor(plugin, [
            hubCandidate(installedOld),
            runnerCandidate('runner-current', { plugins: installedOld })
        ], { overwrite: true })

        expect(plan.targets.map((target) => [target.target.scope, target.action])).toEqual([
            ['hub', 'overwrite'],
            ['runner:runner-current', 'overwrite']
        ])
        expect(plan.blockingErrors).toEqual([])
    })

    it('validates cross-runtime allowVersionSkew policies for the planned ready set', () => {
        const plugin = manifest({
            version: '1.2.4',
            compatibility: {
                crossRuntime: { allowVersionSkew: 'patch' }
            }
        })
        const targets = [
            {
                target: hubCandidate().target,
                runtime: 'hub',
                required: true,
                compatible: true,
                status: 'compatible',
                action: 'unchanged',
                existingVersion: '1.2.3'
            },
            {
                target: runnerCandidate('runner-current').target,
                runtime: 'runner',
                required: true,
                compatible: true,
                status: 'compatible',
                action: 'install'
            }
        ] satisfies Parameters<typeof validateCrossRuntimeVersionPlan>[0]['targets']

        expect(validateCrossRuntimeVersionPlan({ manifest: plugin, targets, candidates: [], overwrite: false })).toEqual([])
        expect(validateCrossRuntimeVersionPlan({
            manifest: manifest({ ...plugin, compatibility: { crossRuntime: { allowVersionSkew: 'none' } } }),
            targets,
            candidates: [],
            overwrite: false
        })[0]).toContain('multiple versions')
        expect(validateCrossRuntimeVersionPlan({
            manifest: manifest({ ...plugin, compatibility: { crossRuntime: { allowVersionSkew: 'minor' } }, version: '2.0.0' }),
            targets,
            candidates: [],
            overwrite: false
        })[0]).toContain('multiple versions')
    })
})
