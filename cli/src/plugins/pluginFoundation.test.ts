import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    AgentCapabilityProviderResultSchema,
    AgentHistoryImportResultSchema,
    AgentDescriptorSchema,
    PluginConfigScopeSchema,
    PluginManifestLiteSchema,
    PluginTargetScopeSchema,
    RunnerCommandResolverProposalSchema,
    RunnerEnvironmentProposalSchema,
    RunnerSpawnHookProposalSchema
} from '@hapi/protocol/plugins'
import { bundledExamplePlugins, getBundledExamplePluginsRoot, prepareBundledExamplePlugins } from '@hapi/protocol/plugins/bundledExamples'
import { SpawnSessionRequestSchema } from '@hapi/protocol/apiTypes'
import {
    discoverPlugins,
    getPluginStateFile,
    getUserPluginInstallDir,
    installPluginFromDirectory,
    installPluginFromPackage,
    splitPluginDirs,
    validatePluginRoot,
    writePluginState,
    readPluginState,
    applyPluginState,
    PluginStateLockError
} from '@hapi/protocol/plugins/foundation'

function writeManifest(root: string, manifest: unknown): void {
    writeFileSync(join(root, 'hapi.plugin.json'), JSON.stringify(manifest, null, 2))
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'com.example.bark',
        name: 'Bark Notifications',
        version: '0.1.0',
        pluginApiVersion: '0.1',
        runtimes: {
            hub: { entry: 'dist/hub.js' }
        },
        contributions: {
            hub: {
                notificationChannels: [{ id: 'bark', displayName: 'Bark' }]
            }
        },
        ...overrides
    }
}

describe('plugin foundation cold path', () => {
    let testDir: string

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'hapi-plugin-foundation-'))
    })

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true })
    })

    it('parses a valid manifest with PluginManifestLiteSchema', () => {
        const parsed = PluginManifestLiteSchema.safeParse(validManifest())
        expect(parsed.success).toBe(true)
    })

    it('rejects invalid id, version, and plugin API version', () => {
        expect(PluginManifestLiteSchema.safeParse(validManifest({ id: 'bad/id' })).success).toBe(false)
        expect(PluginManifestLiteSchema.safeParse(validManifest({ version: 'latest' })).success).toBe(false)
        expect(PluginManifestLiteSchema.safeParse(validManifest({ version: '1.0.0-01' })).success).toBe(false)
        expect(PluginManifestLiteSchema.safeParse(validManifest({ pluginApiVersion: '9.9' })).success).toBe(false)
    })

    it('rejects invalid JSON without importing runtime code', async () => {
        const root = join(testDir, 'invalid-json')
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, 'hapi.plugin.json'), '{ invalid json')

        const record = await validatePluginRoot(root)

        expect(record.status).toBe('invalid')
        expect(record.diagnostics.map((entry) => entry.code)).toContain('invalid-json')
        expect(record.manifest).toBeUndefined()
    })

    it('marks unsupported pluginApiVersion as incompatible', async () => {
        const root = join(testDir, 'api-mismatch')
        mkdirSync(join(root, 'dist'), { recursive: true })
        writeFileSync(join(root, 'dist/hub.js'), 'throw new Error("must not import")')
        writeManifest(root, validManifest({ pluginApiVersion: '0.2' }))

        const record = await validatePluginRoot(root)

        expect(record.status).toBe('incompatible')
        expect(record.diagnostics.map((entry) => entry.code)).toContain('plugin-api-version-mismatch')
    })

    it('marks incompatible operating systems as incompatible', async () => {
        const root = join(testDir, 'os-incompatible')
        const unsupportedOs = process.platform === 'darwin' ? 'linux' : 'darwin'
        mkdirSync(join(root, 'dist'), { recursive: true })
        writeFileSync(join(root, 'dist/hub.js'), '')
        writeManifest(root, validManifest({ compatibility: { os: [unsupportedOs] } }))

        const record = await validatePluginRoot(root)

        expect(record.status).toBe('incompatible')
        expect(record.diagnostics.map((entry) => entry.code)).toContain('os-incompatible')
    })

    it('rejects hub entry paths that escape with ../', async () => {
        const root = join(testDir, 'escape')
        mkdirSync(root, { recursive: true })
        writeFileSync(join(testDir, 'evil.js'), '')
        writeManifest(root, validManifest({ runtimes: { hub: { entry: '../evil.js' } } }))

        const record = await validatePluginRoot(root)

        expect(record.status).toBe('invalid')
        expect(record.diagnostics.map((entry) => entry.code)).toContain('entry-path-escape')
    })

    it('rejects hub entry symlinks that resolve outside plugin root', async () => {
        const root = join(testDir, 'symlink-escape')
        const outside = join(testDir, 'outside')
        mkdirSync(join(root, 'dist'), { recursive: true })
        mkdirSync(outside, { recursive: true })
        writeFileSync(join(outside, 'hub.js'), '')
        symlinkSync(join(outside, 'hub.js'), join(root, 'dist/hub.js'))
        writeManifest(root, validManifest())

        const record = await validatePluginRoot(root)

        expect(record.status).toBe('invalid')
        expect(record.diagnostics.map((entry) => entry.code)).toContain('entry-symlink-escape')
    })

    it('discovers HAPI_PLUGIN_DIRS before $HAPI_HOME/plugins and reports duplicate ids deterministically', async () => {
        const envRoot = join(testDir, 'env-plugins')
        const hapiHome = join(testDir, 'hapi-home')
        const envPlugin = join(envRoot, 'first')
        const homePlugin = join(hapiHome, 'plugins', 'second')
        mkdirSync(join(envPlugin, 'dist'), { recursive: true })
        mkdirSync(join(homePlugin, 'dist'), { recursive: true })
        writeFileSync(join(envPlugin, 'dist/hub.js'), 'throw new Error("must not import env")')
        writeFileSync(join(homePlugin, 'dist/hub.js'), 'throw new Error("must not import home")')
        writeManifest(envPlugin, validManifest())
        writeManifest(homePlugin, validManifest())

        const records = await discoverPlugins({ hapiHome, envPluginDirs: envRoot })

        expect(records).toHaveLength(2)
        expect(records[0]?.rootPath).toBe(envPlugin)
        expect(records[0]?.status).toBe('validated')
        expect(records[1]?.rootPath).toBe(homePlugin)
        expect(records[1]?.status).toBe('blocked')
        expect(records[1]?.diagnostics.map((entry) => entry.code)).toContain('duplicate-plugin-id')
    })

    it('scans $HAPI_HOME/plugins child directories without treating the plugins directory itself as a plugin', async () => {
        const hapiHome = join(testDir, 'hapi-home')
        const pluginsRoot = join(hapiHome, 'plugins')
        const childPlugin = join(pluginsRoot, 'child')
        mkdirSync(join(pluginsRoot, 'dist'), { recursive: true })
        mkdirSync(join(childPlugin, 'dist'), { recursive: true })
        writeFileSync(join(pluginsRoot, 'dist/hub.js'), '')
        writeFileSync(join(childPlugin, 'dist/hub.js'), '')
        writeManifest(pluginsRoot, validManifest({ id: 'com.example.root' }))
        writeManifest(childPlugin, validManifest({ id: 'com.example.child' }))

        const records = await discoverPlugins({ hapiHome })

        expect(records.map((record) => record.manifest?.id)).toEqual(['com.example.child'])
    })

    it('prepares and discovers bundled example plugins after user plugins', async () => {
        const hapiHome = join(testDir, 'hapi-home')
        const bundledRoot = await prepareBundledExamplePlugins(hapiHome)
        const records = await discoverPlugins({ hapiHome, bundledPluginDirs: [bundledRoot] })

        expect(records).toHaveLength(bundledExamplePlugins.length)
        expect(records.map((record) => record.source)).toEqual(records.map(() => 'bundled'))
        expect(records.map((record) => record.manifest?.id).sort()).toEqual(bundledExamplePlugins.map((plugin) => plugin.manifest.id).sort())
        expect(records.every((record) => record.status === 'validated')).toBe(true)
    })

    it('prepares bundled example plugins idempotently without rewriting unchanged files', async () => {
        const hapiHome = join(testDir, 'hapi-home')
        const bundledRoot = await prepareBundledExamplePlugins(hapiHome)
        const manifestPath = join(bundledRoot, 'com.hapi.examples.notification-logger', 'hapi.plugin.json')
        const firstMtime = statSync(manifestPath).mtimeMs
        await new Promise((resolve) => setTimeout(resolve, 20))

        await prepareBundledExamplePlugins(hapiHome)

        expect(statSync(manifestPath).mtimeMs).toBe(firstMtime)
    })

    it('lets user-home plugins override bundled example plugin ids', async () => {
        const hapiHome = join(testDir, 'hapi-home')
        const bundledRoot = await prepareBundledExamplePlugins(hapiHome)
        const exampleId = bundledExamplePlugins[0]!.manifest.id
        const userPlugin = join(hapiHome, 'plugins', exampleId)
        mkdirSync(join(userPlugin, 'dist'), { recursive: true })
        writeFileSync(join(userPlugin, 'dist/hub.js'), 'export function activate() {}')
        writeManifest(userPlugin, validManifest({ id: exampleId }))

        const records = await discoverPlugins({ hapiHome, bundledPluginDirs: [bundledRoot] })
        const matches = records.filter((record) => record.manifest?.id === exampleId)

        expect(matches).toHaveLength(2)
        expect(matches[0]?.source).toBe('user-home')
        expect(matches[0]?.status).toBe('validated')
        expect(matches[1]?.source).toBe('bundled')
        expect(matches[1]?.status).toBe('blocked')
    })

    it('refuses bundled example symbolic-link and non-directory output paths', async () => {
        const hapiHome = join(testDir, 'hapi-home')
        const bundledRoot = getBundledExamplePluginsRoot(hapiHome)
        const outsideRoot = join(testDir, 'outside-bundled-root')
        mkdirSync(hapiHome, { recursive: true })

        writeFileSync(bundledRoot, 'not a directory')
        await expect(prepareBundledExamplePlugins(hapiHome)).rejects.toThrow('non-directory')
        rmSync(bundledRoot, { force: true })

        mkdirSync(outsideRoot, { recursive: true })
        symlinkSync(outsideRoot, bundledRoot, 'dir')

        await expect(prepareBundledExamplePlugins(hapiHome)).rejects.toThrow('symbolic link')

        rmSync(bundledRoot, { recursive: true, force: true })
        mkdirSync(bundledRoot, { recursive: true })
        writeFileSync(join(bundledRoot, bundledExamplePlugins[0]!.manifest.id), 'not a directory')
        await expect(prepareBundledExamplePlugins(hapiHome)).rejects.toThrow('non-directory')
        rmSync(join(bundledRoot, bundledExamplePlugins[0]!.manifest.id), { force: true })

        const outsidePlugin = join(testDir, 'outside-bundled-plugin')
        mkdirSync(outsidePlugin, { recursive: true })
        symlinkSync(outsidePlugin, join(bundledRoot, bundledExamplePlugins[0]!.manifest.id), 'dir')

        await expect(prepareBundledExamplePlugins(hapiHome)).rejects.toThrow('symbolic link')

        rmSync(bundledRoot, { recursive: true, force: true })
        const pluginRoot = join(bundledRoot, bundledExamplePlugins[0]!.manifest.id)
        const outsideDist = join(testDir, 'outside-bundled-dist')
        mkdirSync(pluginRoot, { recursive: true })
        mkdirSync(outsideDist, { recursive: true })
        symlinkSync(outsideDist, join(pluginRoot, 'dist'), 'dir')

        await expect(prepareBundledExamplePlugins(hapiHome)).rejects.toThrow('symbolic link')

        rmSync(bundledRoot, { recursive: true, force: true })
        mkdirSync(pluginRoot, { recursive: true })
        writeFileSync(join(pluginRoot, 'dist'), 'not a directory')

        await expect(prepareBundledExamplePlugins(hapiHome)).rejects.toThrow('non-directory')
    })

    it('applies plugins.json enablement and config without changing invalid records', async () => {
        const root = join(testDir, 'state-merge')
        mkdirSync(join(root, 'dist'), { recursive: true })
        writeFileSync(join(root, 'dist/hub.js'), 'throw new Error("must not import")')
        writeManifest(root, validManifest())
        const records = [await validatePluginRoot(root)]

        const enabledRecords = applyPluginState(records, {
            enabled: {
                'com.example.bark': {
                    enabled: true,
                    config: { serverUrl: 'https://api.day.app' }
                }
            }
        })

        expect(enabledRecords[0]?.status).toBe('enabled')
        expect(enabledRecords[0]?.enabled).toBe(true)
        expect(enabledRecords[0]?.config).toEqual({ serverUrl: 'https://api.day.app' })

        const failClosedRecords = applyPluginState(records, { enabled: { 'com.example.bark': { enabled: true } } }, true)
        expect(failClosedRecords[0]?.status).toBe('disabled')
        expect(failClosedRecords[0]?.enabled).toBe(false)
    })

    it('supports default-enabled bundled plugins with explicit disable override', async () => {
        const root = join(testDir, 'default-enabled-state')
        mkdirSync(root, { recursive: true })
        writeManifest(root, validManifest({ id: 'com.example.default', runtimes: undefined, contributions: undefined }))
        const records = [await validatePluginRoot(root)]

        const defaultEnabled = applyPluginState(records, { enabled: {} }, { defaultEnabledPluginIds: ['com.example.default'] })
        expect(defaultEnabled[0]?.status).toBe('enabled')
        expect(defaultEnabled[0]?.enabled).toBe(true)

        const explicitlyDisabled = applyPluginState(records, {
            enabled: { 'com.example.default': { enabled: false } }
        }, { defaultEnabledPluginIds: ['com.example.default'] })
        expect(explicitlyDisabled[0]?.status).toBe('disabled')
        expect(explicitlyDisabled[0]?.enabled).toBe(false)
    })

    it('safe-fails plugins.json writes when a lock file already exists', async () => {
        const stateFile = getPluginStateFile(testDir)
        writeFileSync(`${stateFile}.lock`, 'existing')

        await expect(writePluginState(stateFile, { enabled: {} })).rejects.toBeInstanceOf(PluginStateLockError)
    })

    it('installs a valid plugin directory into the user plugin root without importing it', async () => {
        const sourceRoot = join(testDir, 'source')
        const marker = join(testDir, 'imported')
        mkdirSync(join(sourceRoot, 'dist'), { recursive: true })
        writeFileSync(join(sourceRoot, 'dist/hub.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export function activate() {}`)
        writeManifest(sourceRoot, validManifest({ id: 'com.example.install' }))

        const result = await installPluginFromDirectory({ hapiHome: testDir, sourcePath: sourceRoot })

        expect(result.action).toBe('installed')
        expect(result.record.manifest?.id).toBe('com.example.install')
        expect(result.targetPath).toBe(getUserPluginInstallDir(testDir, 'com.example.install'))
        expect(existsSync(join(result.targetPath, 'hapi.plugin.json'))).toBe(true)
        expect(existsSync(marker)).toBe(false)
        await expect(installPluginFromDirectory({ hapiHome: testDir, sourcePath: sourceRoot })).rejects.toThrow('already installed')
    })

    it('rejects symlink plugin source paths during install', async () => {
        const sourceRoot = join(testDir, 'source-symlink-target')
        const sourceLink = join(testDir, 'source-symlink')
        mkdirSync(join(sourceRoot, 'dist'), { recursive: true })
        writeFileSync(join(sourceRoot, 'dist/hub.js'), 'export function activate() {}')
        writeManifest(sourceRoot, validManifest({ id: 'com.example.symlink' }))
        symlinkSync(sourceRoot, sourceLink, 'dir')

        await expect(installPluginFromDirectory({ hapiHome: testDir, sourcePath: sourceLink })).rejects.toThrow('symbolic link')
    })

    it('installs plugin packages only after checksum and package manifest validation', async () => {
        const sourceRoot = join(testDir, 'package-source')
        mkdirSync(join(sourceRoot, 'dist'), { recursive: true })
        writeFileSync(join(sourceRoot, 'dist/hub.js'), 'export function activate() {}')
        const manifest = validManifest({ id: 'com.example.package', version: '1.2.3' })
        const parsedManifest = PluginManifestLiteSchema.parse(manifest)
        writeManifest(sourceRoot, manifest)
        const packagePath = join(testDir, 'plugin.tgz')
        execFileSync('tar', ['-czf', packagePath, '-C', sourceRoot, '.'])
        const bytes = readFileSync(packagePath)
        const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
        const hubEntryChecksum = `sha256:${createHash('sha256').update(readFileSync(join(sourceRoot, 'dist/hub.js'))).digest('hex')}`

        await expect(installPluginFromPackage({
            hapiHome: testDir,
            filename: 'plugin.tgz',
            contentBase64: bytes.toString('base64'),
            checksum: 'sha256:deadbeef',
            format: 'tgz'
        })).rejects.toThrow('checksum mismatch')

        await expect(installPluginFromPackage({
            hapiHome: testDir,
            filename: 'plugin.tgz',
            contentBase64: bytes.toString('base64'),
            checksum,
            format: 'tgz',
            manifest: {
                formatVersion: 'hapi-plugin-package/v1',
                manifest: parsedManifest,
                checksum,
                files: [{ path: './dist/hub.js', sha256: 'sha256:deadbeef' }],
                signature: { algorithm: 'test-none', value: 'unsigned-test' }
            }
        })).rejects.toThrow('file checksum mismatch')

        await expect(installPluginFromPackage({
            hapiHome: testDir,
            filename: 'plugin.tgz',
            contentBase64: bytes.toString('base64'),
            checksum,
            format: 'tgz',
            manifest: {
                formatVersion: 'hapi-plugin-package/v1',
                manifest: PluginManifestLiteSchema.parse(validManifest({ id: 'com.example.other' })),
                checksum,
                files: [{ path: './dist/hub.js', sha256: hubEntryChecksum }]
            }
        })).rejects.toThrow('metadata does not match')

        const result = await installPluginFromPackage({
            hapiHome: testDir,
            filename: 'plugin.tgz',
            contentBase64: bytes.toString('base64'),
            checksum,
            format: 'tgz',
            manifest: {
                formatVersion: 'hapi-plugin-package/v1',
                manifest: parsedManifest,
                checksum,
                files: [{ path: './dist/hub.js', sha256: hubEntryChecksum }],
                signature: { algorithm: 'test-none', value: 'unsigned-test' }
            }
        })

        expect(result.action).toBe('installed')
        expect(result.checksum).toBe(checksum)
        expect(result.packageFormat).toBe('tgz')
        expect(result.record.manifest?.id).toBe('com.example.package')
        expect(existsSync(join(getUserPluginInstallDir(testDir, 'com.example.package'), 'hapi.plugin.json'))).toBe(true)
    })

    it('reads plugins.json parse errors as fail-closed disabled state', async () => {
        const stateFile = getPluginStateFile(testDir)
        writeFileSync(stateFile, '{ not json')

        const result = await readPluginState(stateFile)

        expect(result.failClosed).toBe(true)
        expect(result.state.enabled).toEqual({})
        expect(result.parseError).toBeTruthy()
    })

    it('normalizes legacy seeded core plugin state without fail-closing', async () => {
        const stateFile = getPluginStateFile(testDir)
        writeFileSync(stateFile, JSON.stringify({
            enabled: {},
            seededCorePluginIds: { 'com.hapi.core.schedule-send': true },
            seededDefaultPluginIds: { 'com.hapi.schedule-send': true }
        }))

        const result = await readPluginState(stateFile)

        expect(result.failClosed).toBe(false)
        expect(result.parseError).toBeUndefined()
        expect(result.state.seededDefaultPluginIds).toEqual({
            'com.hapi.core.schedule-send': true,
            'com.hapi.schedule-send': true
        })
    })

    it('writes plugins.json atomically with enabled config state only', async () => {
        const stateFile = getPluginStateFile(testDir)

        await writePluginState(stateFile, {
            enabled: {
                'com.example.bark': {
                    enabled: true,
                    config: { serverUrl: 'https://api.day.app' }
                }
            }
        })

        const result = await readPluginState(stateFile)
        expect(result.failClosed).toBe(false)
        expect(result.state.enabled['com.example.bark']?.config).toEqual({ serverUrl: 'https://api.day.app' })
    })

    it('splits HAPI_PLUGIN_DIRS using an explicit Windows delimiter', () => {
        expect(splitPluginDirs('C:\\hapi\\one;D:\\hapi\\two;;E:\\hapi\\three', ';')).toEqual([
            'C:\\hapi\\one',
            'D:\\hapi\\two',
            'E:\\hapi\\three'
        ])
    })
})

describe('plugin multi-runtime schemas', () => {
    it('rejects invalid plugin target scopes', () => {
        expect(PluginTargetScopeSchema.safeParse('hub').success).toBe(true)
        expect(PluginTargetScopeSchema.safeParse('all-runners').success).toBe(true)
        expect(PluginTargetScopeSchema.safeParse('runner:runner-1').success).toBe(true)
        expect(PluginTargetScopeSchema.safeParse('runner:bad/id').success).toBe(false)
        expect(PluginTargetScopeSchema.safeParse('workspace').success).toBe(false)
        expect(PluginConfigScopeSchema.safeParse('hub:com.example.plugin').success).toBe(true)
        expect(PluginConfigScopeSchema.safeParse('runner:runner-1:com.example.plugin').success).toBe(true)
        expect(PluginConfigScopeSchema.safeParse('agent:runner-1:vendor:agent:com.example.plugin').success).toBe(true)
        expect(PluginConfigScopeSchema.safeParse('runner:bad/id:com.example.plugin').success).toBe(false)
    })

    it('accepts Runner runtime and contribution declarations', () => {
        const parsed = PluginManifestLiteSchema.safeParse(validManifest({
            runtimes: {
                runner: { entry: 'dist/runner.js' }
            },
            contributions: {
                runner: {
                    environmentProviders: [{ id: 'env', displayName: 'Env' }],
                    commandResolvers: [{ id: 'cmd' }],
                    spawnHooks: [{ id: 'spawn' }]
                },
                agent: {
                    adapters: [{ id: 'codex' }],
                    capabilityProviders: [{ id: 'caps' }]
                },
                voice: {
                    providers: [{ id: 'voice', displayName: 'Voice Provider', supportStatus: 'unsupported' }]
                },
                deployment: {
                    packs: [{ id: 'docker', displayName: 'Docker Pack', supportStatus: 'stub' }]
                },
                integration: {
                    protocolBridges: [{ id: 'mcp', displayName: 'MCP Bridge', supportStatus: 'unsupported', limitations: ['No bridge runtime yet.'], protocol: 'mcp' }]
                },
                web: {
                    settingsPanels: [{
                        id: 'settings',
                        title: 'Settings',
                        components: [{ kind: 'text', text: 'Hello' }]
                    }],
                    newSessionFields: [{ id: 'field', key: 'profile', label: 'Profile' }],
                    actions: [{ id: 'action', label: 'Reload', actionId: 'plugin.reload' }],
                    badges: [{ id: 'badge', label: 'Ready' }]
                }
            }
        }))

        expect(parsed.success).toBe(true)
    })

    it('rejects invalid generic contribution support status values', () => {
        const parsed = PluginManifestLiteSchema.safeParse(validManifest({
            contributions: {
                voice: {
                    providers: [{ id: 'voice', supportStatus: 'experimental' }]
                }
            }
        }))

        expect(parsed.success).toBe(false)
    })

    it('validates Runner extension proposal schemas', () => {
        expect(RunnerEnvironmentProposalSchema.safeParse({
            env: { EXAMPLE_HOME: '/opt/example' },
            pathPrepend: ['/opt/example/bin']
        }).success).toBe(true)
        expect(RunnerEnvironmentProposalSchema.safeParse({ env: { BAD: 42 } }).success).toBe(false)
        expect(RunnerCommandResolverProposalSchema.safeParse({ args: ['codex', '--model', 'gpt-5.5'] }).success).toBe(true)
        expect(RunnerCommandResolverProposalSchema.safeParse({ command: '/bin/sh' }).success).toBe(false)
        expect(RunnerSpawnHookProposalSchema.safeParse({ block: { reason: 'policy' } }).success).toBe(true)
    })

    it('validates plugin agent descriptors and accepts plugin agent spawn ids', () => {
        expect(AgentDescriptorSchema.safeParse({
            id: 'vendor:example-agent',
            displayName: 'Example Agent',
            adapter: {
                runtime: 'runner',
                kind: 'custom-runner-plugin',
                contributionId: 'example-adapter'
            },
            capabilities: {
                permissionModes: ['default', 'yolo'],
                models: ['example-small']
            }
        }).success).toBe(true)
        expect(AgentDescriptorSchema.safeParse({
            id: 'bad/agent',
            displayName: 'Bad Agent',
            adapter: {
                runtime: 'runner',
                kind: 'custom-runner-plugin',
                contributionId: 'bad'
            }
        }).success).toBe(false)
        expect(SpawnSessionRequestSchema.safeParse({
            directory: '/repo',
            agent: 'vendor:example-agent'
        }).success).toBe(true)
        expect(SpawnSessionRequestSchema.safeParse({
            directory: '/repo',
            agent: 'bad/agent'
        }).success).toBe(false)
    })

    it('validates agent capability provider and history importer schemas', () => {
        expect(AgentCapabilityProviderResultSchema.safeParse({
            models: [{ id: 'example-large', displayName: 'Example Large', contextWindow: 200000 }],
            permissionModes: [{ mode: 'yolo', risk: 'danger' }],
            profiles: [{ id: 'fast', displayName: 'Fast' }],
            sessions: [{ id: 'native-1', title: 'Native Session', importable: true }],
            usage: [{ totalTokens: 123, costUsd: 0.02 }],
            skills: [{ name: 'review' }],
            slashCommands: [{ name: 'audit' }]
        }).success).toBe(true)
        expect(AgentCapabilityProviderResultSchema.safeParse({
            models: [{ id: '' }]
        }).success).toBe(false)
        expect(AgentCapabilityProviderResultSchema.safeParse({
            permissionModes: [{ mode: 'root' }]
        }).success).toBe(false)
        expect(AgentHistoryImportResultSchema.safeParse({
            messages: [{ role: 'user', content: 'hello', createdAt: 1 }]
        }).success).toBe(true)
        expect(AgentHistoryImportResultSchema.safeParse({
            messages: [{ role: 'assistant', content: 'hello' }]
        }).success).toBe(false)
    })

    it('validates Runner entry paths with the same escape guards as Hub entries', async () => {
        const testDir = mkdtempSync(join(tmpdir(), 'hapi-runner-entry-'))
        try {
            const root = join(testDir, 'escape')
            mkdirSync(root, { recursive: true })
            writeFileSync(join(testDir, 'evil.js'), '')
            writeManifest(root, validManifest({ runtimes: { runner: { entry: '../evil.js' } } }))

            const record = await validatePluginRoot(root)

            expect(record.status).toBe('invalid')
            expect(record.diagnostics.map((entry) => entry.code)).toContain('entry-path-escape')
        } finally {
            rmSync(testDir, { recursive: true, force: true })
        }
    })
})
