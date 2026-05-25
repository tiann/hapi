import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { PluginManifestLiteSchema, pluginManifestRequiresRunnerInstall } from '@hapi/protocol/plugins'
import {
    HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID,
    HAPI_SCHEDULE_SEND_PLUGIN_ID,
    HAPI_SERVERCHAN_NOTIFIER_PLUGIN_ID,
    bundledFirstPartyPlugins
} from '@hapi/protocol/plugins/bundledCore'
import { bundledExamplePlugins } from '@hapi/protocol/plugins/bundledExamples'
import { RunnerPluginManager } from './runnerPluginManager'

function writeManifest(root: string, overrides: Record<string, unknown> = {}): void {
    writeFileSync(join(root, 'hapi.plugin.json'), JSON.stringify({
        id: 'com.example.runner',
        name: 'Runner Plugin',
        version: '0.1.0',
        pluginApiVersion: '0.1',
        runtimes: {
            runner: { entry: 'dist/runner.js' }
        },
        contributions: {
            runner: {
                environmentProviders: [{ id: 'env-provider', displayName: 'Env Provider' }]
            }
        },
        ...overrides
    }, null, 2))
}

function writeState(hapiHome: string, enabled = true): void {
    writeFileSync(join(hapiHome, 'plugins.json'), JSON.stringify({
        enabled: { 'com.example.runner': { enabled } }
    }, null, 2))
}


function installBundledFirstPartyPlugin(hapiHome: string, pluginId: string): void {
    const plugin = bundledFirstPartyPlugins.find((entry) => entry.manifest.id === pluginId)
    if (!plugin) throw new Error(`Missing bundled plugin ${pluginId}`)
    const root = join(hapiHome, 'plugins', plugin.manifest.id)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'hapi.plugin.json'), JSON.stringify(plugin.manifest, null, 2))
    for (const file of plugin.files) {
        const target = join(root, file.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.content)
    }
}

describe('RunnerPluginManager runtime', () => {
    let testDir: string
    let pluginRoot: string
    let runnerEntry: string
    let logFile: string

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'hapi-runner-plugin-manager-'))
        pluginRoot = join(testDir, 'plugins', 'com.example.runner')
        runnerEntry = join(pluginRoot, 'dist', 'runner.js')
        logFile = join(testDir, 'runner-events.jsonl')
        mkdirSync(join(pluginRoot, 'dist'), { recursive: true })
        writeFileSync(runnerEntry, 'throw new Error("runner runtime must not import while disabled")')
        writeManifest(pluginRoot)
    })

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true })
    })

    it('discovers Runner runtime declarations without importing disabled runner entry', async () => {
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        await manager.start()
        const plugins = manager.listPlugins()

        expect(plugins).toHaveLength(1)
        expect(plugins[0]).toMatchObject({
            id: 'com.example.runner',
            active: false,
            runtimes: { runner: { entry: 'dist/runner.js', active: false } },
            target: { scope: 'runner:runner-1', runtime: 'runner', machineId: 'runner-1', active: true, stale: false }
        })
        expect(manager.getInventory()).toMatchObject({ machineId: 'runner-1', plugins: [{ id: 'com.example.runner' }] })
    })

    it('activates enabled Runner plugins and writes Runner-local state/config', async () => {
        writeFileSync(runnerEntry, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                appendFileSync(log, JSON.stringify({ type: 'activate', machineId: ctx.machineId, label: ctx.config.get('label') }) + '\\n');
                ctx.runtime.registerEnvironmentProvider({ id: 'env' });
            }
        `)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()

        const result = await manager.enablePlugin('com.example.runner', { label: 'Runner' })
        const state = JSON.parse(readFileSync(join(testDir, 'plugins.json'), 'utf8')) as { enabled: Record<string, { enabled: boolean; scopedConfig?: Record<string, { config: Record<string, unknown>; updatedAt?: number }> }> }

        expect(result.ok).toBe(true)
        expect(result.results[0]).toMatchObject({ id: 'com.example.runner', action: 'activated', status: 'active' })
        expect(state.enabled['com.example.runner']?.enabled).toBe(true)
        expect(state.enabled['com.example.runner']?.scopedConfig?.['runner:runner-1:com.example.runner']?.config).toEqual({ label: 'Runner' })
        expect(state.enabled['com.example.runner']?.scopedConfig?.['runner:runner-1:com.example.runner']?.updatedAt).toBeTypeOf('number')
        expect(manager.listPlugins()[0]).toMatchObject({ status: 'active', enabled: true, active: true, runtimes: { runner: { active: true } } })
        expect(readFileSync(logFile, 'utf8')).toContain('"machineId":"runner-1"')
    })

    it('uses Runner scoped config without overwriting Hub scoped config', async () => {
        writeFileSync(runnerEntry, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                appendFileSync(log, JSON.stringify({ label: ctx.config.get('label') }) + '\\n');
            }
        `)
        writeFileSync(join(testDir, 'plugins.json'), JSON.stringify({
            enabled: {
                'com.example.runner': {
                    enabled: true,
                    scopedConfig: {
                        'hub:com.example.runner': { config: { label: 'Hub' }, updatedAt: 1 },
                        'runner:runner-1:com.example.runner': { config: { label: 'Runner' }, updatedAt: 2 }
                    }
                }
            }
        }, null, 2))
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()

        expect(readFileSync(logFile, 'utf8')).toContain('"label":"Runner"')
        expect(manager.getPlugin('com.example.runner')?.configMetadata).toMatchObject({
            scope: 'runner:runner-1:com.example.runner',
            source: 'scoped',
            config: { label: 'Runner' }
        })

        await manager.updatePluginConfig('com.example.runner', { label: 'Runner updated' }, false)
        const state = JSON.parse(readFileSync(join(testDir, 'plugins.json'), 'utf8')) as { enabled: Record<string, { scopedConfig: Record<string, { config: Record<string, unknown> }> }> }
        expect(state.enabled['com.example.runner']?.scopedConfig['hub:com.example.runner']?.config).toEqual({ label: 'Hub' })
        expect(state.enabled['com.example.runner']?.scopedConfig['runner:runner-1:com.example.runner']?.config).toEqual({ label: 'Runner updated' })
    })

    it('falls back to Hub mirror config for Runner plugins that only expose Web settings through Hub', async () => {
        writeFileSync(runnerEntry, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                appendFileSync(log, JSON.stringify({ label: ctx.config.get('label') }) + '\\n');
            }
        `)
        writeManifest(pluginRoot, {
            contributions: {
                runner: {
                    environmentProviders: [{ id: 'env-provider', displayName: 'Env Provider' }]
                },
                web: {
                    settingsPanels: [{
                        id: 'runner-settings',
                        title: 'Runner settings',
                        components: [{ id: 'defaults', kind: 'runnerSpawnDefaultsEditor' }]
                    }]
                }
            }
        })
        writeFileSync(join(testDir, 'plugins.json'), JSON.stringify({
            enabled: {
                'com.example.runner': {
                    enabled: true,
                    scopedConfig: {
                        'hub:com.example.runner': { config: { label: 'Hub mirror' }, updatedAt: 1 }
                    }
                }
            }
        }, null, 2))
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()

        expect(readFileSync(logFile, 'utf8')).toContain('"label":"Hub mirror"')
        expect(manager.getPlugin('com.example.runner')?.configMetadata).toMatchObject({
            scope: 'runner:runner-1:com.example.runner',
            source: 'scoped',
            config: { label: 'Hub mirror' }
        })
    })

    it('reports Runner secret status and missing-secret diagnostics without leaking values', async () => {
        writeFileSync(runnerEntry, 'export function activate() {}')
        writeManifest(pluginRoot, { permissions: { secrets: ['RUNNER_TOKEN'] } })
        writeState(testDir)
        const managerWithSecret = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: { RUNNER_TOKEN: 'super-secret-value' } })
        await managerWithSecret.start()

        const detail = managerWithSecret.getPlugin('com.example.runner')
        expect(detail?.permissions.secrets[0]).toMatchObject({
            name: 'RUNNER_TOKEN',
            present: true,
            required: true,
            target: { scope: 'runner:runner-1' },
            configScope: 'runner:runner-1:com.example.runner'
        })
        expect(JSON.stringify(detail)).not.toContain('super-secret-value')
        await managerWithSecret.dispose()

        const managerMissingSecret = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await managerMissingSecret.start()
        expect(managerMissingSecret.getDiagnostics()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'com.example.runner',
                code: 'missing-secret'
            })
        ]))
        expect(managerMissingSecret.getDiagnostics()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'plugin-secret-missing' })
        ]))
        expect(JSON.stringify(managerMissingSecret.getDiagnostics())).not.toContain('super-secret-value')
    })

    it('discovers bundled example plugins when enabled for the Runner manager', async () => {
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {}, includeBundledExamples: true })
        await manager.start()
        const plugins = manager.listPlugins()

        expect(plugins.map((plugin) => plugin.id).sort()).toEqual([
            'com.example.runner',
            ...bundledExamplePlugins
                .filter((plugin) => pluginManifestRequiresRunnerInstall(plugin.manifest))
                .map((plugin) => plugin.manifest.id)
        ].sort())
        expect(plugins.find((plugin) => plugin.id === 'com.hapi.examples.echo-agent')).toMatchObject({
            source: 'bundled',
            enabled: false,
            active: false,
            install: { sourceType: 'bundled' }
        })
        await manager.dispose()
    })

    it('does not default-install optional Runner plugins with first-party defaults enabled', async () => {
        const manager = new RunnerPluginManager({
            hapiHome: testDir,
            machineId: 'runner-1',
            env: {},
            includeBundledCore: true
        })
        await manager.start()

        const pluginIds = manager.listPlugins().map((plugin) => plugin.id)
        expect(pluginIds).toContain('com.example.runner')
        expect(pluginIds).not.toEqual(expect.arrayContaining([
            HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID,
            HAPI_SCHEDULE_SEND_PLUGIN_ID,
            HAPI_SERVERCHAN_NOTIFIER_PLUGIN_ID
        ]))

        await manager.dispose()
    })

    it('applies installed Runner launch presets before building spawn args and respects manual fields', async () => {
        installBundledFirstPartyPlugin(testDir, HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID)
        const manager = new RunnerPluginManager({
            hapiHome: testDir,
            machineId: 'runner-1',
            env: {},
            includeBundledCore: true
        })
        await manager.start()
        await manager.enablePlugin(HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID, {
            agentIds: ['codex'],
            directoryPrefixes: ['/repo'],
            model: 'gpt-5-codex',
            modelReasoningEffort: 'xhigh',
            permissionMode: 'yolo'
        })

        const defaults = await manager.resolveSpawnOptions({
            options: { directory: '/repo', agent: 'codex' },
            agent: 'codex',
            cwd: '/repo/project'
        })
        expect(defaults.options).toMatchObject({
            model: 'gpt-5-codex',
            modelReasoningEffort: 'xhigh',
            permissionMode: 'yolo'
        })
        expect(defaults.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID,
                code: 'runner-launch-presets-applied'
            })
        ]))
        expect(defaults.applied).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID,
                contributionId: 'runner-launch-presets',
                label: expect.any(String),
                fields: expect.arrayContaining(['model', 'modelReasoningEffort', 'permissionMode'])
            })
        ]))

        const manual = await manager.resolveSpawnOptions({
            options: {
                directory: '/repo',
                agent: 'codex',
                model: 'manual-model',
                manualFields: ['model']
            },
            agent: 'codex',
            cwd: '/repo/project'
        })
        expect(manual.options.model).toBe('manual-model')
        expect(manual.options.modelReasoningEffort).toBe('xhigh')
        await manager.dispose()
    })

    it('respects the bundled example disable flag for the Runner manager', async () => {
        const manager = new RunnerPluginManager({
            hapiHome: testDir,
            machineId: 'runner-1',
            env: { HAPI_DISABLE_BUNDLED_EXAMPLE_PLUGINS: '1' },
            includeBundledExamples: true
        })
        await manager.start()
        const plugins = manager.listPlugins()

        expect(plugins.map((plugin) => plugin.id)).toEqual(['com.example.runner'])
        await manager.dispose()
    })

    it('activates bundled Runner echo agent and capability examples', async () => {
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {}, includeBundledExamples: true })
        await manager.start()
        const result = await manager.enablePlugin('com.hapi.examples.echo-agent')

        expect(result.ok).toBe(true)
        expect(manager.getAgentDescriptor('example:echo')).toMatchObject({
            id: 'example:echo',
            displayName: 'Example Echo Agent',
            source: 'plugin',
            pluginId: 'com.hapi.examples.echo-agent',
            capabilities: {
                models: expect.arrayContaining(['echo-small', 'echo-large'])
            }
        })
        expect(manager.getAgentCapabilities()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                agentId: 'example:echo',
                pluginId: 'com.hapi.examples.echo-agent',
                contributionId: 'example-echo-capabilities'
            })
        ]))
        await expect(manager.deletePlugin('com.hapi.examples.echo-agent')).rejects.toThrow('cannot be deleted')
        await manager.dispose()
    })

    it('applies bundled Runner environment example to spawn plans', async () => {
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {}, includeBundledExamples: true })
        await manager.start()
        await manager.enablePlugin('com.hapi.examples.runner-environment', { envValue: 'from-test' })

        const plan = await manager.resolveSpawnPlan({
            options: { directory: '/repo', agent: 'codex' },
            agent: 'codex',
            basePlan: {
                command: '/opt/hapi/current',
                args: ['codex'],
                displayArgs: ['codex'],
                mode: 'compiled'
            },
            cwd: '/repo',
            env: { PATH: '/usr/bin' }
        })

        expect(plan.env.EXAMPLE_RUNNER_ENV).toBe('from-test')
        expect(plan.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'com.hapi.examples.runner-environment',
                code: 'example-runner-environment'
            })
        ]))
        await manager.dispose()
    })

    it('ignores Hub-runtime-only plugins in the Runner process', async () => {
        writeManifest(pluginRoot, {
            runtimes: { hub: { entry: 'dist/hub.js' } },
            contributions: { hub: { notificationChannels: [{ id: 'hub', displayName: 'Hub' }] } }
        })
        writeFileSync(join(pluginRoot, 'dist', 'hub.js'), 'throw new Error("Runner must not import Hub runtime")')
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const result = await manager.start()

        expect(result.ok).toBe(true)
        expect(manager.listPlugins()).toEqual([])
    })

    it('marks unsupported declared Runner extension points incompatible before activation', async () => {
        writeManifest(pluginRoot, {
            compatibility: {
                runner: { extensionPoints: ['hub.action'] }
            }
        })
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const result = await manager.start()
        await expect(manager.enablePlugin('com.example.runner')).rejects.toThrow('cannot be enabled')

        expect(result.ok).toBe(false)
        expect(result.results[0]).toMatchObject({ status: 'incompatible' })
        expect(JSON.stringify(manager.listPlugins())).toContain('hub.action')
    })

    it('keeps the previous active Runner plugin when reload activation fails', async () => {
        writeFileSync(runnerEntry, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                appendFileSync(log, 'activate-v1\\n');
                ctx.runtime.registerEnvironmentProvider({ id: 'env', dispose() { appendFileSync(log, 'dispose-v1\\n'); } });
            }
        `)
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()
        expect(manager.listPlugins()[0]?.active).toBe(true)

        writeFileSync(runnerEntry, 'export function activate() { throw new Error("boom") }')
        const result = await manager.reload('com.example.runner')

        expect(result.ok).toBe(false)
        expect(result.results[0]).toMatchObject({ action: 'kept-previous', status: 'reload-failed' })
        expect(manager.listPlugins()[0]).toMatchObject({ status: 'reload-failed', active: true })
        expect(readFileSync(logFile, 'utf8')).not.toContain('dispose-v1')
        await manager.dispose()
        expect(readFileSync(logFile, 'utf8')).toContain('dispose-v1')
    })

    it('disposes Runner resources on disable and shutdown without throwing on dispose failures', async () => {
        writeFileSync(runnerEntry, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.runtime.registerEnvironmentProvider({ id: 'env', dispose() { appendFileSync(log, 'dispose-env\\n'); } });
                ctx.runtime.registerSpawnHook({ id: 'spawn', dispose() { throw new Error('dispose failed'); } });
            }
        `)
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()

        const result = await manager.disablePlugin('com.example.runner')
        await manager.dispose()

        expect(result.ok).toBe(true)
        expect(result.results[0]).toMatchObject({ action: 'deactivated', status: 'disabled' })
        expect(readFileSync(logFile, 'utf8')).toContain('dispose-env')
    })


    it('disposes a plugin activated while shutdown is requested', async () => {
        writeFileSync(runnerEntry, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export async function activate(ctx) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                ctx.runtime.registerEnvironmentProvider({ id: 'env', dispose() { appendFileSync(log, 'dispose-race\\n'); } });
            }
        `)
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const reload = manager.start()
        await new Promise((resolve) => setTimeout(resolve, 5))
        await manager.dispose()
        await reload

        expect(manager.listPlugins()[0]?.active).not.toBe(true)
        expect(readFileSync(logFile, 'utf8')).toContain('dispose-race')
    })

    it('reports activation failures without crashing the Runner manager', async () => {
        writeFileSync(runnerEntry, 'export function activate() { throw new Error("activation failed") }')
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const result = await manager.start()

        expect(result.ok).toBe(false)
        expect(manager.listPlugins()[0]).toMatchObject({ status: 'failed', active: false })
        expect(manager.getDiagnostics().some((diagnostic) => diagnostic.code === 'runner-plugin-activate-failed')).toBe(true)
    })

    it('times out never-resolving activation without blocking the Runner manager', async () => {
        writeFileSync(runnerEntry, 'export async function activate() { await new Promise(() => undefined) }')
        writeState(testDir)
        const manager = new RunnerPluginManager({
            hapiHome: testDir,
            machineId: 'runner-1',
            env: {},
            activationTimeoutMs: 20
        })

        const result = await manager.start()

        expect(result.ok).toBe(false)
        expect(result.results[0]).toMatchObject({ action: 'failed', status: 'failed' })
        expect(result.results[0]?.message).toContain('timed out')
        expect(manager.listPlugins()[0]).toMatchObject({ status: 'failed', active: false })
        expect(manager.getInventory()).toMatchObject({ machineId: 'runner-1' })
    })

    it('registers plugin agent adapters and exposes runner-local descriptors and factories', async () => {
        writeFileSync(runnerEntry, `
            export function activate(ctx) {
                ctx.runtime.registerAgentAdapter({
                    id: 'example-adapter',
                    descriptor: {
                        id: 'vendor:example-agent',
                        displayName: 'Example Agent',
                        description: 'Example plugin-backed agent',
                        adapter: {
                            runtime: 'runner',
                            kind: 'custom-runner-plugin',
                            contributionId: 'example-adapter'
                        },
                        capabilities: {
                            supportsResume: false,
                            permissionModes: ['default', 'yolo'],
                            models: ['example-small', 'example-large']
                        }
                    },
                    createBackend() {
                        return {
                            async initialize() {},
                            async newSession() { return 'plugin-session'; },
                            async prompt() {},
                            async cancelPrompt() {},
                            async respondToPermission() {},
                            onPermissionRequest() {},
                            async disconnect() {}
                        };
                    }
                });
            }
        `)
        writeManifest(pluginRoot, {
            contributions: {
                agent: {
                    adapters: [{ id: 'example-adapter', displayName: 'Example Agent Adapter' }]
                }
            },
            capabilities: [{
                id: 'agent-adapter-ready',
                kind: 'agent.adapter',
                displayName: 'Agent adapter ready',
                parts: {
                    runner: {
                        contributions: [{ type: 'agentAdapter', id: 'example-adapter' }]
                    }
                }
            }]
        })
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const result = await manager.start()

        expect(result.ok).toBe(true)
        const descriptor = manager.getAgentDescriptor('vendor:example-agent')
        expect(descriptor).toMatchObject({
            id: 'vendor:example-agent',
            displayName: 'Example Agent',
            source: 'plugin',
            pluginId: 'com.example.runner',
            available: true,
            capabilities: {
                permissionModes: ['default', 'yolo'],
                models: ['example-small', 'example-large']
            }
        })
        expect(manager.getAgentAdapterFactory('vendor:example-agent')).toBeTypeOf('function')
        expect(manager.getAgentDescriptor('claude')).toMatchObject({ id: 'claude', source: 'builtin' })
        expect(manager.getPlugin('com.example.runner')?.contributions.agent?.adapters).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'example-adapter',
                agentId: 'vendor:example-agent',
                active: true
            })
        ]))
        expect(manager.getPlugin('com.example.runner')?.contributions.agent?.adapters).toHaveLength(1)
        expect(manager.collectContributionStates()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                contributionType: 'agentAdapter',
                contributionId: 'example-adapter',
                registered: true,
                active: true
            })
        ]))
        expect(manager.collectCapabilities()[0]).toMatchObject({
            capabilityId: 'agent-adapter-ready',
            status: 'ready',
            parts: { runner: { registered: true, active: true } }
        })
    })

    it('rejects invalid plugin agent descriptors during activation before spawn', async () => {
        writeFileSync(runnerEntry, `
            export function activate(ctx) {
                ctx.runtime.registerAgentAdapter({
                    id: 'example-adapter',
                    descriptor: {
                        id: 'other-agent',
                        displayName: 'Broken Agent',
                        adapter: {
                            runtime: 'runner',
                            kind: 'custom-runner-plugin',
                            contributionId: 'broken-adapter'
                        }
                    },
                    createBackend() {
                        return {};
                    }
                });
            }
        `)
        writeManifest(pluginRoot, {
            contributions: {
                agent: {
                    adapters: [{ id: 'broken-adapter', displayName: 'Broken Agent Adapter' }]
                }
            }
        })
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const result = await manager.start()

        expect(result.ok).toBe(false)
        expect(manager.getAgentDescriptor('vendor:example-agent')).toBeNull()
        expect(manager.getAgentAdapterFactory('vendor:example-agent')).toBeNull()
        expect(manager.listPlugins()[0]).toMatchObject({ status: 'failed', active: false })
        expect(manager.getDiagnostics()).toEqual(expect.arrayContaining([
            expect.objectContaining({ pluginId: 'com.example.runner', code: 'runner-plugin-activate-failed' })
        ]))
    })

    it('collects agent capability provider snapshots and merges model and permission descriptors', async () => {
        writeFileSync(runnerEntry, `
            export function activate(ctx) {
                ctx.runtime.registerAgentAdapter({
                    id: 'example-adapter',
                    descriptor: {
                        id: 'vendor:example-agent',
                        displayName: 'Example Agent',
                        adapter: {
                            runtime: 'runner',
                            kind: 'custom-runner-plugin',
                            contributionId: 'example-adapter'
                        },
                        capabilities: {
                            permissionModes: ['default', 'yolo']
                        }
                    },
                    createBackend() {
                        return {
                            async initialize() {},
                            async newSession() { return 'plugin-session'; },
                            async prompt() {},
                            async cancelPrompt() {},
                            async respondToPermission() {},
                            onPermissionRequest() {},
                            async disconnect() {}
                        };
                    }
                });
                ctx.runtime.registerAgentCapabilityProvider({
                    id: 'example-capabilities',
                    agentId: 'vendor:example-agent',
                    provide() {
                        return {
                            models: [{ id: 'example-large', displayName: 'Example Large' }],
                            permissionModes: [{ mode: 'yolo', label: 'YOLO', risk: 'danger' }],
                            profiles: [{ id: 'fast', displayName: 'Fast profile' }],
                            sessions: [{ id: 'native-session-1', title: 'Native Session' }],
                            usage: [{ totalTokens: 42, costUsd: 0.01 }],
                            skills: [{ name: 'review', description: 'Review code' }],
                            slashCommands: [{ name: 'audit', description: 'Audit code' }]
                        };
                    }
                });
            }
        `)
        writeManifest(pluginRoot, {
            contributions: {
                agent: {
                    adapters: [{ id: 'example-adapter', displayName: 'Example Agent Adapter' }],
                    capabilityProviders: [{ id: 'example-capabilities', displayName: 'Example Capabilities' }]
                }
            }
        })
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const result = await manager.start()

        expect(result.ok).toBe(true)
        expect(manager.getAgentCapabilities()).toEqual([
            expect.objectContaining({
                agentId: 'vendor:example-agent',
                pluginId: 'com.example.runner',
                contributionId: 'example-capabilities',
                capabilities: expect.objectContaining({
                    models: [expect.objectContaining({ id: 'example-large', displayName: 'Example Large' })],
                    profiles: [expect.objectContaining({ id: 'fast', displayName: 'Fast profile' })],
                    sessions: [expect.objectContaining({ id: 'native-session-1', title: 'Native Session' })],
                    usage: [expect.objectContaining({ totalTokens: 42, costUsd: 0.01 })],
                    skills: [expect.objectContaining({ name: 'review' })],
                    slashCommands: [expect.objectContaining({ name: 'audit' })]
                })
            })
        ])
        expect(manager.getAgentDescriptor('vendor:example-agent')).toMatchObject({
            capabilities: {
                models: ['example-large'],
                permissionModes: ['default', 'yolo']
            }
        })
        expect(manager.getPlugin('com.example.runner')?.contributions.agent?.capabilityProviders).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'example-capabilities', active: true })
        ]))
    })

    it('does not let capability providers expand permissions or target agents owned by other plugins', async () => {
        writeFileSync(runnerEntry, `
            export function activate(ctx) {
                ctx.runtime.registerAgentAdapter({
                    id: 'example-adapter',
                    descriptor: {
                        id: 'vendor:example-agent',
                        displayName: 'Example Agent',
                        adapter: {
                            runtime: 'runner',
                            kind: 'custom-runner-plugin',
                            contributionId: 'example-adapter'
                        },
                        capabilities: {
                            permissionModes: ['default']
                        }
                    },
                    createBackend() {
                        return {
                            async initialize() {},
                            async newSession() { return 'plugin-session'; },
                            async prompt() {},
                            async cancelPrompt() {},
                            async respondToPermission() {},
                            onPermissionRequest() {},
                            async disconnect() {}
                        };
                    }
                });
                ctx.runtime.registerAgentCapabilityProvider({
                    id: 'unsafe-permissions',
                    agentId: 'vendor:example-agent',
                    provide() {
                        return {
                            permissionModes: [{ mode: 'yolo', label: 'YOLO', risk: 'danger' }],
                            usage: [{ scope: 'session', sessionId: 'session-1', totalTokens: 1 }]
                        };
                    }
                });
                ctx.runtime.registerAgentCapabilityProvider({
                    id: 'cross-agent',
                    agentId: 'claude',
                    provide() {
                        return { models: [{ id: 'fake-claude-model' }] };
                    }
                });
            }
        `)
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const result = await manager.start()

        expect(result.ok).toBe(true)
        expect(manager.getAgentDescriptor('vendor:example-agent')).toMatchObject({
            capabilities: {
                permissionModes: ['default']
            }
        })
        expect(manager.getAgentDescriptor('claude')?.capabilities.models).toBeUndefined()
        expect(manager.getDiagnostics()).toEqual(expect.arrayContaining([
            expect.objectContaining({ pluginId: 'com.example.runner', code: 'agent-capability-provider-permission-mode-not-owned' }),
            expect.objectContaining({ pluginId: 'com.example.runner', code: 'agent-capability-provider-session-usage-rejected' }),
            expect.objectContaining({ pluginId: 'com.example.runner', code: 'agent-capability-provider-agent-not-owned' })
        ]))
        const codes = manager.getDiagnostics().map((diagnostic) => diagnostic.code)
        expect(codes.filter((code) => code === 'agent-capability-provider-permission-mode-not-owned')).toHaveLength(1)
        expect(codes.filter((code) => code === 'agent-capability-provider-session-usage-rejected')).toHaveLength(1)
    })

    it('keeps capability provider failures diagnostic without crashing the runner manager', async () => {
        writeFileSync(runnerEntry, `
            export function activate(ctx) {
                ctx.runtime.registerAgentAdapter({
                    id: 'example-adapter',
                    descriptor: {
                        id: 'vendor:example-agent',
                        displayName: 'Example Agent',
                        adapter: {
                            runtime: 'runner',
                            kind: 'custom-runner-plugin',
                            contributionId: 'example-adapter'
                        }
                    },
                    createBackend() {
                        return {
                            async initialize() {},
                            async newSession() { return 'plugin-session'; },
                            async prompt() {},
                            async cancelPrompt() {},
                            async respondToPermission() {},
                            onPermissionRequest() {},
                            async disconnect() {}
                        };
                    }
                });
                ctx.runtime.registerAgentCapabilityProvider({
                    id: 'bad-capabilities',
                    agentId: 'vendor:example-agent',
                    provide() {
                        return { models: [{ id: '' }] };
                    }
                });
            }
        `)
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const result = await manager.start()

        expect(result.ok).toBe(true)
        expect(manager.getAgentCapabilities()[0]).toMatchObject({
            agentId: 'vendor:example-agent',
            contributionId: 'bad-capabilities',
            capabilities: {},
            diagnostics: [expect.objectContaining({ code: 'agent-capability-provider-failed' })]
        })
        expect(manager.getDiagnostics()).toEqual(expect.arrayContaining([
            expect.objectContaining({ pluginId: 'com.example.runner', code: 'agent-capability-provider-failed' })
        ]))
    })

    it('validates history importer output before returning unified history messages', async () => {
        writeFileSync(runnerEntry, `
            export function activate(ctx) {
                ctx.runtime.registerAgentAdapter({
                    id: 'example-adapter',
                    descriptor: {
                        id: 'vendor:example-agent',
                        displayName: 'Example Agent',
                        adapter: {
                            runtime: 'runner',
                            kind: 'custom-runner-plugin',
                            contributionId: 'example-adapter'
                        }
                    },
                    createBackend() {
                        return {
                            async initialize() {},
                            async newSession() { return 'plugin-session'; },
                            async prompt() {},
                            async cancelPrompt() {},
                            async respondToPermission() {},
                            onPermissionRequest() {},
                            async disconnect() {}
                        };
                    }
                });
                ctx.runtime.registerAgentCapabilityProvider({
                    id: 'history',
                    agentId: 'vendor:example-agent',
                    importHistory() {
                        return { messages: [{ role: 'assistant', content: 'not a valid role' }] };
                    }
                });
            }
        `)
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()

        await expect(manager.importAgentHistory({
            agentId: 'vendor:example-agent',
            nativeSessionId: 'native-session-1'
        })).rejects.toThrow('history importer returned invalid messages')
        expect(manager.getDiagnostics()).toEqual(expect.arrayContaining([
            expect.objectContaining({ pluginId: 'com.example.runner', code: 'agent-history-import-failed' })
        ]))
    })

    it('redacts declared secrets from action, capability provider, and history importer failures', async () => {
        writeFileSync(runnerEntry, `
            export function activate(ctx) {
                ctx.runtime.registerAgentAdapter({
                    id: 'example-adapter',
                    descriptor: {
                        id: 'vendor:example-agent',
                        displayName: 'Example Agent',
                        adapter: {
                            runtime: 'runner',
                            kind: 'custom-runner-plugin',
                            contributionId: 'example-adapter'
                        }
                    },
                    createBackend() {
                        return {
                            async initialize() {},
                            async newSession() { return 'plugin-session'; },
                            async prompt() {},
                            async cancelPrompt() {},
                            async respondToPermission() {},
                            onPermissionRequest() {},
                            async disconnect() {}
                        };
                    }
                });
                ctx.runtime.registerAgentCapabilityProvider({
                    id: 'bad-capabilities',
                    agentId: 'vendor:example-agent',
                    provide() { throw new Error('capability leaked super-secret-value'); },
                    importHistory() { throw new Error('history leaked super-secret-value'); }
                });
                ctx.actions.register({
                    id: 'run-secret-action',
                    kind: 'test.action',
                    run() { throw new Error('action leaked super-secret-value'); }
                });
            }
        `)
        writeManifest(pluginRoot, {
            permissions: { secrets: ['RUNNER_TOKEN'] },
            contributions: {
                agent: {
                    adapters: [{ id: 'example-adapter', displayName: 'Example Agent Adapter' }],
                    capabilityProviders: [{ id: 'bad-capabilities', displayName: 'Bad Capabilities' }]
                }
            }
        })
        writeState(testDir)
        const manager = new RunnerPluginManager({
            hapiHome: testDir,
            machineId: 'runner-1',
            env: { RUNNER_TOKEN: 'super-secret-value' }
        })
        await manager.start()

        const actionResult = await manager.invokeAction({
            pluginId: 'com.example.runner',
            actionId: 'run-secret-action',
            namespace: 'default',
            payload: {}
        })
        await expect(manager.importAgentHistory({
            agentId: 'vendor:example-agent',
            nativeSessionId: 'native-session-1',
            providerId: 'bad-capabilities'
        })).rejects.toThrow('[REDACTED]')

        expect(actionResult).toMatchObject({
            ok: false,
            code: 'plugin-action-failed',
            message: expect.stringContaining('[REDACTED]')
        })
        const serialized = JSON.stringify({
            actionResult,
            diagnostics: manager.getDiagnostics(),
            capabilities: manager.getAgentCapabilities()
        })
        expect(serialized).toContain('[REDACTED]')
        expect(serialized).not.toContain('super-secret-value')
    })

    it('applies active Runner extension proposals to spawn plans', async () => {
        writeFileSync(runnerEntry, `
            export function activate(ctx) {
                ctx.runtime.registerEnvironmentProvider({
                    id: 'env',
                    priority: 1,
                    provide() {
                        return {
                            env: { EXAMPLE_TOOL_HOME: '/opt/example' },
                            pathPrepend: ['/opt/example/bin'],
                            diagnostics: [{ severity: 'info', code: 'custom-env-diagnostic', message: 'env provider ran' }]
                        };
                    }
                });
                ctx.runtime.registerCommandResolver({
                    id: 'cmd',
                    resolve() {
                        return { args: ['codex', '--model', 'gpt-5.5'] };
                    }
                });
            }
        `)
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()

        const plan = await manager.resolveSpawnPlan({
            options: { directory: '/repo', agent: 'codex' },
            agent: 'codex',
            basePlan: {
                command: '/opt/hapi/current',
                args: ['codex'],
                displayArgs: ['codex'],
                mode: 'compiled'
            },
            cwd: '/repo',
            env: { PATH: '/usr/bin' }
        })

        expect(plan.env.EXAMPLE_TOOL_HOME).toBe('/opt/example')
        expect(plan.env.PATH).toBe('/opt/example/bin:/usr/bin')
        expect(plan.displayArgs).toEqual(['codex', '--model', 'gpt-5.5'])
        expect(manager.getPlugin('com.example.runner')?.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ pluginId: 'com.example.runner', code: 'custom-env-diagnostic' }),
            expect.objectContaining({ pluginId: 'com.example.runner', code: 'runner-extension-audit' })
        ]))
        expect(manager.getInventory().extensions?.environmentProviders).toEqual([
            expect.objectContaining({ pluginId: 'com.example.runner', id: 'env', type: 'environmentProvider', active: true })
        ])
    })

    it('isolates throwing hooks and runs afterSpawn/onExit diagnostics without crashing', async () => {
        writeFileSync(runnerEntry, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.runtime.registerSpawnHook({
                    id: 'spawn',
                    beforeSpawn() { throw new Error('before failed'); },
                    afterSpawn(input) { appendFileSync(log, 'after:' + input.pid + '\\n'); },
                    onExit(input) { appendFileSync(log, 'exit:' + input.exitCode + ':' + input.signal + '\\n'); }
                });
            }
        `)
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()
        const plan = await manager.resolveSpawnPlan({
            options: { directory: '/repo', agent: 'codex' },
            agent: 'codex',
            basePlan: {
                command: '/opt/hapi/current',
                args: ['codex'],
                displayArgs: ['codex'],
                mode: 'compiled'
            },
            cwd: '/repo',
            env: {}
        })

        expect(plan.blocked).toBeUndefined()
        expect(plan.diagnostics.map((entry) => entry.code)).toContain('runner-extension-before-spawn-failed')
        expect(manager.getPlugin('com.example.runner')?.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ pluginId: 'com.example.runner', code: 'runner-extension-before-spawn-failed' })
        ]))
        await manager.notifyAfterSpawn({
            context: { machineId: 'runner-1', agent: 'codex', directory: '/repo', cwd: '/repo', args: ['codex'], envKeys: [] },
            pid: 123
        })
        await manager.notifyExit({
            context: { machineId: 'runner-1', agent: 'codex', directory: '/repo', cwd: '/repo', args: ['codex'], envKeys: [] },
            pid: 123,
            exitCode: 0,
            signal: null
        })

        const log = readFileSync(logFile, 'utf8')
        expect(log).toContain('after:123')
        expect(log).toContain('exit:0:null')
    })

    it('attributes afterSpawn and onExit failures to the plugin detail diagnostics', async () => {
        writeFileSync(runnerEntry, `
            export function activate(ctx) {
                ctx.runtime.registerSpawnHook({
                    id: 'spawn',
                    afterSpawn() { throw new Error('after failed'); },
                    onExit() { throw new Error('exit failed'); }
                });
            }
        `)
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()

        const context = { machineId: 'runner-1', agent: 'codex', directory: '/repo', cwd: '/repo', args: ['codex'], envKeys: [] }
        await manager.notifyAfterSpawn({ context, pid: 123 })
        await manager.notifyExit({ context, pid: 123, exitCode: 1, signal: null })

        const diagnostics = manager.getPlugin('com.example.runner')?.diagnostics ?? []
        expect(diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ pluginId: 'com.example.runner', code: 'runner-extension-after-spawn-failed' }),
            expect.objectContaining({ pluginId: 'com.example.runner', code: 'runner-extension-on-exit-failed' })
        ]))
    })

    it('installs Runner local-path plugins and records per-target install metadata', async () => {
        const sourceRoot = join(testDir, 'source-runner-plugin')
        mkdirSync(join(sourceRoot, 'dist'), { recursive: true })
        writeFileSync(join(sourceRoot, 'dist', 'runner.js'), 'export function activate() {}')
        writeManifest(sourceRoot, { id: 'com.installed.runner', version: '1.2.3' })
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()

        const result = await manager.installLocalPlugin({ sourcePath: sourceRoot, reload: true })
        const state = JSON.parse(readFileSync(join(testDir, 'plugins.json'), 'utf8')) as {
            enabled: Record<string, { install?: { sourceType: string; sourcePath?: string; version?: string; installedAt?: number; updatedAt?: number } }>
        }

        expect(result.ok).toBe(true)
        expect(result.pluginId).toBe('com.installed.runner')
        expect(result.target?.scope).toBe('runner:runner-1')
        expect(state.enabled['com.installed.runner']?.install).toMatchObject({
            sourceType: 'runner-local-path',
            sourcePath: sourceRoot,
            version: '1.2.3'
        })
        expect(state.enabled['com.installed.runner']?.install?.installedAt).toBeTypeOf('number')
        expect(manager.getInventory().plugins.find((entry) => entry.id === 'com.installed.runner')?.install).toMatchObject({
            sourceType: 'runner-local-path',
            version: '1.2.3'
        })
    })

    it('installs uploaded Runner packages and rejects checksum mismatches', async () => {
        const packageSource = join(testDir, 'package-runner-plugin')
        mkdirSync(join(packageSource, 'dist'), { recursive: true })
        writeFileSync(join(packageSource, 'dist', 'runner.js'), 'export function activate() {}')
        writeManifest(packageSource, { id: 'com.package.runner', version: '2.0.0' })
        const packageManifest = PluginManifestLiteSchema.parse(JSON.parse(readFileSync(join(packageSource, 'hapi.plugin.json'), 'utf8')) as unknown)
        const packagePath = join(testDir, 'runner-plugin.tgz')
        execFileSync('tar', ['-czf', packagePath, '-C', packageSource, '.'])
        const packageBytes = readFileSync(packagePath)
        const checksum = `sha256:${createHash('sha256').update(packageBytes).digest('hex')}`
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()

        await expect(manager.installPluginPackage({
            filename: 'runner-plugin.tgz',
            contentBase64: packageBytes.toString('base64'),
            checksum: 'sha256:deadbeef',
            format: 'tgz'
        })).rejects.toThrow('checksum mismatch')

        const result = await manager.installPluginPackage({
            filename: 'runner-plugin.tgz',
            contentBase64: packageBytes.toString('base64'),
            checksum,
            format: 'tgz',
            manifest: {
                formatVersion: 'hapi-plugin-package/v1',
                manifest: packageManifest,
                checksum,
                files: [{ path: './hapi.plugin.json' }],
                signature: { algorithm: 'test-none', value: 'unsigned-test' }
            }
        })
        const state = JSON.parse(readFileSync(join(testDir, 'plugins.json'), 'utf8')) as {
            enabled: Record<string, { install?: { sourceType: string; checksum?: string; packageFormat?: string; version?: string } }>
        }

        expect(result.ok).toBe(true)
        expect(result.pluginId).toBe('com.package.runner')
        expect(state.enabled['com.package.runner']?.install).toMatchObject({
            sourceType: 'uploaded-package',
            checksum,
            packageFormat: 'tgz',
            version: '2.0.0'
        })
    })

    it('does not import invalid Runner plugins', async () => {
        const marker = join(testDir, 'invalid-imported')
        writeFileSync(runnerEntry, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export function activate() {}`)
        writeManifest(pluginRoot, { id: 'bad/id' })
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const result = await manager.start()

        expect(result.ok).toBe(false)
        expect(existsSync(marker)).toBe(false)
        expect(manager.listPlugins()[0]).toMatchObject({ status: 'invalid', active: false })
    })
})
