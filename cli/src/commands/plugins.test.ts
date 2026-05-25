import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { bundledFirstPartyPlugins } from '@hapi/protocol/plugins/bundledCore'

type PluginsModule = typeof import('./plugins')


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

function writeManifest(root: string, overrides: Record<string, unknown> = {}) {
    writeFileSync(join(root, 'hapi.plugin.json'), JSON.stringify({
        id: 'com.example.plugin',
        name: 'Plugin',
        version: '0.1.0',
        pluginApiVersion: '0.1',
        runtimes: { hub: { entry: 'hub.js' } },
        ...overrides
    }, null, 2))
}

async function importPlugins(
    hapiHome: string,
    options: { disableBundledExamples?: boolean; enableBundledExamples?: boolean } = { disableBundledExamples: true }
): Promise<PluginsModule> {
    process.env.HAPI_HOME = hapiHome
    if (options.enableBundledExamples === true) {
        process.env.HAPI_ENABLE_BUNDLED_EXAMPLES = '1'
    } else {
        delete process.env.HAPI_ENABLE_BUNDLED_EXAMPLES
    }
    if (options.disableBundledExamples !== false) {
        process.env.HAPI_DISABLE_BUNDLED_EXAMPLE_PLUGINS = '1'
    } else {
        delete process.env.HAPI_DISABLE_BUNDLED_EXAMPLE_PLUGINS
    }
    vi.resetModules()
    return await import('./plugins')
}

describe('hapi plugins command', () => {
    let testDir: string
    let hapiHome: string
    let pluginRoot: string
    let logs: string[]
    let errors: string[]

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'hapi-cli-plugins-'))
        hapiHome = join(testDir, 'home')
        pluginRoot = join(hapiHome, 'plugins', 'com.example.plugin')
        mkdirSync(pluginRoot, { recursive: true })
        logs = []
        errors = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })
        vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')) })
    })

    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env.HAPI_HOME
        delete process.env.CLI_API_TOKEN
        delete process.env.HAPI_ENABLE_BUNDLED_EXAMPLES
        delete process.env.HAPI_DISABLE_BUNDLED_EXAMPLE_PLUGINS
        vi.doUnmock('@/api/pluginAdmin')
        rmSync(testDir, { recursive: true, force: true })
    })

    it('lists discovered plugins as stable JSON', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot)
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['list', '--json'])

        const payload = JSON.parse(logs.join('\n')) as { plugins: Array<{ id: string; status: string; enabled: boolean }> }
        expect(payload.plugins).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'com.example.plugin', status: 'disabled', enabled: false })
        ]))
    })

    it('does not list bundled example plugins by default', async () => {
        rmSync(pluginRoot, { recursive: true, force: true })
        const { handlePluginsCommand } = await importPlugins(hapiHome, { disableBundledExamples: false })

        await handlePluginsCommand(['list', '--json'])

        const payload = JSON.parse(logs.join('\n')) as { plugins: Array<{ id: string; source: string; enabled: boolean }> }
        expect(payload.plugins.map((plugin) => plugin.id)).not.toContain('com.hapi.examples.notification-logger')
    })

    it('lists bundled example plugins only when explicitly enabled', async () => {
        rmSync(pluginRoot, { recursive: true, force: true })
        const { handlePluginsCommand } = await importPlugins(hapiHome, {
            disableBundledExamples: false,
            enableBundledExamples: true
        })

        await handlePluginsCommand(['list', '--json'])

        const payload = JSON.parse(logs.join('\n')) as { plugins: Array<{ id: string; source: string; enabled: boolean }> }
        expect(payload.plugins).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'com.hapi.examples.notification-logger',
                source: 'bundled',
                enabled: false
            })
        ]))
    })

    it('lists default-installed first-party plugins as user-home plugins even when examples are disabled', async () => {
        rmSync(pluginRoot, { recursive: true, force: true })
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['list', '--json'])

        const payload = JSON.parse(logs.join('\n')) as { plugins: Array<{ id: string; source: string; enabled: boolean }> }
        expect(payload.plugins).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'com.hapi.schedule-send',
                source: 'user-home',
                enabled: true
            })
        ]))
        expect(payload.plugins.map((plugin) => plugin.id)).not.toEqual(expect.arrayContaining([
            'com.hapi.serverchan-notifier',
            'com.hapi.runner-launch-presets'
        ]))
    })

    it('inspects installed semantic contribution descriptors', async () => {
        rmSync(pluginRoot, { recursive: true, force: true })
        installBundledFirstPartyPlugin(hapiHome, 'com.hapi.serverchan-notifier')
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['inspect', 'com.hapi.serverchan-notifier', '--json'])

        const payload = JSON.parse(logs.join('\n')) as {
            plugin: {
                contributions: {
                    notificationChannels?: Array<{ id: string; displayName?: string }>
                }
                permissions: { network: string[]; secrets: Array<{ name: string; present: boolean }> }
            }
        }
        expect(payload.plugin.contributions.notificationChannels).toEqual([
            expect.objectContaining({
                id: 'serverchan',
                displayName: 'ServerChan Notifier'
            })
        ])
        expect(payload.plugin.permissions).toEqual(expect.objectContaining({
            network: ['https://sctapi.ftqq.com'],
            secrets: [expect.objectContaining({ name: 'SERVERCHAN_SENDKEY', present: false })]
        }))
    })

    it('enables and disables plugins with atomic plugins.json writes', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot)
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['enable', 'com.example.plugin', '--yes'])
        let state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, { enabled: boolean }> }
        expect(state.enabled['com.example.plugin']?.enabled).toBe(true)

        await handlePluginsCommand(['disable', 'com.example.plugin', '--yes'])
        state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, { enabled: boolean }> }
        expect(state.enabled['com.example.plugin']?.enabled).toBe(false)
        expect(existsSync(join(hapiHome, 'plugins.json.lock'))).toBe(false)
    })

    it('inspect and list do not import runtime code', async () => {
        const marker = join(testDir, 'imported')
        writeFileSync(join(pluginRoot, 'hub.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export function activate() {}`)
        writeManifest(pluginRoot)
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['inspect', 'com.example.plugin', '--json'])
        await handlePluginsCommand(['list', '--json'])

        expect(existsSync(marker)).toBe(false)
    })

    it('sets config values without storing declared secrets', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot, { permissions: { secrets: ['PLUGIN_TOKEN'] } })
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['enable', 'com.example.plugin', '--yes', '--config', '{"url":"https://example.test"}'])
        await handlePluginsCommand(['config', 'set', 'com.example.plugin', 'retries', '3'])
        const state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, { config: Record<string, unknown> }> }

        expect(state.enabled['com.example.plugin']?.config).toEqual({ url: 'https://example.test', retries: 3 })
        expect(JSON.stringify(state)).not.toContain('secret-value')
    })


    it('refuses to persist declared, secret-shaped, or redacted config values', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot, { permissions: { secrets: ['PLUGIN_TOKEN'] } })
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await expect(handlePluginsCommand(['enable', 'com.example.plugin', '--yes', '--config', '{"nested":{"PLUGIN_TOKEN":"secret-value"}}'])).rejects.toThrow('declared secret')
        await expect(handlePluginsCommand(['enable', 'com.example.plugin', '--yes', '--config', '{"nested":{"webhookToken":"secret-value"}}'])).rejects.toThrow('secret-like field')
        await expect(handlePluginsCommand(['enable', 'com.example.plugin', '--yes', '--config', '{"nested":{"safe":"[REDACTED]"}}'])).rejects.toThrow('redacted placeholder')
        await handlePluginsCommand(['enable', 'com.example.plugin', '--yes', '--config', '{"url":"https://example.test"}'])

        const state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, { config?: Record<string, unknown> }> }
        expect(JSON.stringify(state)).not.toContain('secret-value')
        expect(state.enabled['com.example.plugin']?.config).toEqual({ url: 'https://example.test' })
    })

    it('preserves scoped config when using legacy local config and enable commands', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot)
        writeFileSync(join(hapiHome, 'plugins.json'), JSON.stringify({
            enabled: {
                'com.example.plugin': {
                    enabled: false,
                    config: { label: 'legacy' },
                    configUpdatedAt: 1,
                    scopedConfig: {
                        'hub:com.example.plugin': { config: { label: 'Hub' }, updatedAt: 2 },
                        'runner:runner-1:com.example.plugin': { config: { label: 'Runner' }, updatedAt: 3 }
                    },
                    install: { sourceType: 'user-home', version: '0.1.0' }
                }
            }
        }, null, 2))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['config', 'set', 'com.example.plugin', 'label', '"legacy-updated"'])
        await handlePluginsCommand(['enable', 'com.example.plugin', '--yes'])
        await handlePluginsCommand(['disable', 'com.example.plugin', '--yes'])

        const state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as {
            enabled: Record<string, { config?: Record<string, unknown>; scopedConfig?: Record<string, { config: Record<string, unknown>; updatedAt?: number }>; install?: unknown }>
        }
        expect(state.enabled['com.example.plugin']?.config).toEqual({ label: 'legacy-updated' })
        expect(state.enabled['com.example.plugin']?.scopedConfig?.['hub:com.example.plugin']).toEqual({ config: { label: 'Hub' }, updatedAt: 2 })
        expect(state.enabled['com.example.plugin']?.scopedConfig?.['runner:runner-1:com.example.plugin']).toEqual({ config: { label: 'Runner' }, updatedAt: 3 })
        expect(state.enabled['com.example.plugin']?.install).toEqual({ sourceType: 'user-home', version: '0.1.0' })
    })

    it('deletes user-home plugin files and state as JSON', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot)
        writeFileSync(join(hapiHome, 'plugins.json'), JSON.stringify({
            enabled: { 'com.example.plugin': { enabled: true, config: { label: 'v1' } } }
        }, null, 2))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['delete', 'com.example.plugin', '--yes', '--json'])

        const payload = JSON.parse(logs.join('\n')) as { pluginId: string; deleted: boolean; rootPath: string }
        expect(payload.pluginId).toBe('com.example.plugin')
        expect(payload.deleted).toBe(true)
        expect(existsSync(pluginRoot)).toBe(false)
        const state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, unknown> }
        expect(state.enabled['com.example.plugin']).toBeUndefined()
    })

    it('sends local install requests to the selected remote target without importing runtime code', async () => {
        const sourceRoot = join(testDir, 'source-plugin')
        const marker = join(testDir, 'imported-by-install')
        mkdirSync(sourceRoot, { recursive: true })
        writeFileSync(join(sourceRoot, 'hub.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export function activate() {}`)
        writeManifest(sourceRoot, { id: 'com.local.install' })
        process.env.CLI_API_TOKEN = 'test-token'
        const installRemoteLocalPlugin = vi.fn(async () => ({
            ok: true,
            action: 'installed',
            pluginId: 'com.local.install',
            targetPath: '/runner/plugins/com.local.install',
            diagnostics: [],
            plugins: []
        }))
        vi.doMock('@/api/pluginAdmin', () => ({
            getRemotePlugin: vi.fn(),
            getRemotePlugins: vi.fn(),
            getRemotePluginMarketplace: vi.fn(),
            getRemotePluginMarketplaceEntry: vi.fn(),
            refreshRemotePluginMarketplace: vi.fn(),
            createRemoteMarketplaceInstallPlan: vi.fn(),
            updateRemotePluginConfig: vi.fn(),
            reloadRemotePlugins: vi.fn(),
            installRemoteLocalPlugin,
            installRemotePackagePlugin: vi.fn()
        }))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['install-local', sourceRoot, '--target', 'runner:runner-1', '--enable', '--reload', '--overwrite', '--json'])

        const payload = JSON.parse(logs.join('\n')) as { pluginId: string; action: string }
        expect(payload.pluginId).toBe('com.local.install')
        expect(payload.action).toBe('installed')
        expect(installRemoteLocalPlugin).toHaveBeenCalledWith('test-token', {
            sourcePath: sourceRoot,
            enable: true,
            reload: true,
            overwrite: true
        }, 120000, 'runner:runner-1')
        expect(existsSync(join(hapiHome, 'plugins', 'com.local.install', 'hapi.plugin.json'))).toBe(false)
        expect(existsSync(marker)).toBe(false)
    })

    it('uploads package installs with checksum and manifest-driven install plan', async () => {
        const packagePath = join(testDir, 'plugin.tgz')
        const content = Buffer.from('fake-package-bytes')
        writeFileSync(packagePath, content)
        process.env.CLI_API_TOKEN = 'test-token'
        const createRemotePluginInstallPlan = vi.fn(async () => ({
            planId: 'plan-1',
            createdAt: 1,
            plugin: { id: 'com.package.install', name: 'Package plugin', version: '1.0.0' },
            source: { type: 'uploaded-package', filename: 'plugin.tgz', checksum: 'sha256:test', format: 'tgz' },
            positions: ['hub'],
            targets: [{
                target: { scope: 'hub', runtime: 'hub', active: true },
                runtime: 'hub',
                required: true,
                compatible: true,
                status: 'compatible',
                action: 'install'
            }],
            warnings: [],
            blockingErrors: []
        }))
        const executeRemotePluginInstallPlan = vi.fn(async () => ({
            ok: true,
            action: 'installed',
            pluginId: 'com.package.install',
            targetPath: '/hub/plugins/com.package.install',
            diagnostics: [],
            plugins: []
        }))
        vi.doMock('@/api/pluginAdmin', () => ({
            getRemotePlugin: vi.fn(),
            getRemotePlugins: vi.fn(),
            getRemotePluginMarketplace: vi.fn(),
            getRemotePluginMarketplaceEntry: vi.fn(),
            refreshRemotePluginMarketplace: vi.fn(),
            createRemoteMarketplaceInstallPlan: vi.fn(),
            updateRemotePluginConfig: vi.fn(),
            reloadRemotePlugins: vi.fn(),
            installRemoteLocalPlugin: vi.fn(),
            createRemotePluginInstallPlan,
            executeRemotePluginInstallPlan
        }))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['install-package', packagePath, '--json'])

        const expectedChecksum = `sha256:${createHash('sha256').update(content).digest('hex')}`
        expect(createRemotePluginInstallPlan).toHaveBeenCalledWith('test-token', expect.objectContaining({
            filename: 'plugin.tgz',
            contentBase64: content.toString('base64'),
            checksum: expectedChecksum,
            format: 'tgz',
            enable: false,
            reload: false,
            overwrite: false,
            runnerSelection: { mode: 'compatible' }
        }), 120000)
        expect(executeRemotePluginInstallPlan).toHaveBeenCalledWith('test-token', 'plan-1', 120000)
    })

    it('installs marketplace plugins through the remote marketplace install plan', async () => {
        process.env.CLI_API_TOKEN = 'test-token'
        const createRemoteMarketplaceInstallPlan = vi.fn(async () => ({
            marketplace: {
                sourceUrl: 'https://raw.githubusercontent.com/tiann/hapi/main/marketplace/catalog.v1.json',
                pluginId: 'com.market.plugin',
                repo: 'example/market-plugin',
                version: '1.0.0',
                assetUrl: 'https://github.com/example/market-plugin/releases/download/v1.0.0/plugin.tgz',
                checksum: 'sha256:abc'
            },
            plan: {
                planId: 'market-plan-1',
                createdAt: 1,
                plugin: { id: 'com.market.plugin', name: 'Market plugin', version: '1.0.0' },
                source: { type: 'uploaded-package', filename: 'plugin.tgz', checksum: 'sha256:abc', format: 'tgz' },
                positions: ['hub'],
                targets: [{
                    target: { scope: 'hub', runtime: 'hub', active: true },
                    runtime: 'hub',
                    required: true,
                    compatible: true,
                    status: 'compatible',
                    action: 'install'
                }],
                warnings: [],
                blockingErrors: []
            }
        }))
        const executeRemotePluginInstallPlan = vi.fn(async () => ({
            ok: true,
            action: 'installed',
            pluginId: 'com.market.plugin',
            targetPath: '/hub/plugins/com.market.plugin',
            diagnostics: [],
            plugins: []
        }))
        vi.doMock('@/api/pluginAdmin', () => ({
            getRemotePlugin: vi.fn(),
            getRemotePlugins: vi.fn(),
            getRemotePluginMarketplace: vi.fn(),
            getRemotePluginMarketplaceEntry: vi.fn(),
            refreshRemotePluginMarketplace: vi.fn(),
            createRemoteMarketplaceInstallPlan,
            updateRemotePluginConfig: vi.fn(),
            reloadRemotePlugins: vi.fn(),
            installRemoteLocalPlugin: vi.fn(),
            createRemotePluginInstallPlan: vi.fn(),
            executeRemotePluginInstallPlan
        }))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['marketplace', 'install', 'com.market.plugin', '--enable', '--json'])

        expect(createRemoteMarketplaceInstallPlan).toHaveBeenCalledWith('test-token', 'com.market.plugin', expect.objectContaining({
            enable: true,
            reload: false,
            overwrite: false,
            runnerSelection: { mode: 'compatible' }
        }), 120000)
        expect(executeRemotePluginInstallPlan).toHaveBeenCalledWith('test-token', 'market-plan-1', 120000)
        const payload = JSON.parse(logs.join('\n')) as { result: { pluginId: string } }
        expect(payload.result.pluginId).toBe('com.market.plugin')
    })

    it('shows marketplace installed/update status and supports update alias', async () => {
        process.env.CLI_API_TOKEN = 'test-token'
        const getRemotePluginMarketplace = vi.fn(async () => ({
            sourceUrl: 'catalog.json',
            fetchedAt: 1,
            entries: [{
                id: 'com.market.plugin',
                name: 'Market plugin',
                repo: 'example/market-plugin',
                latestCompatibleVersion: '1.1.0',
                releases: [{
                    version: '1.1.0',
                    tag: 'v1.1.0',
                    manifest: {
                        id: 'com.market.plugin',
                        name: 'Market plugin',
                        version: '1.1.0',
                        pluginApiVersion: '0.1',
                        runtimes: { hub: { entry: 'hub.js' } }
                    },
                    package: {
                        filename: 'plugin.tgz',
                        url: 'https://github.com/example/market-plugin/releases/download/v1.1.0/plugin.tgz',
                        format: 'tgz',
                        checksum: `sha256:${'a'.repeat(64)}`
                    }
                }],
                installed: { version: '1.0.0', updateAvailable: true, updateVersion: '1.1.0', enabled: true }
            }]
        }))
        const createRemoteMarketplaceInstallPlan = vi.fn(async () => ({
            marketplace: {
                sourceUrl: 'catalog.json',
                pluginId: 'com.market.plugin',
                repo: 'example/market-plugin',
                version: '1.1.0',
                assetUrl: 'https://github.com/example/market-plugin/releases/download/v1.1.0/plugin.tgz',
                checksum: 'sha256:abc'
            },
            plan: {
                planId: 'market-plan-1',
                createdAt: 1,
                plugin: { id: 'com.market.plugin', name: 'Market plugin', version: '1.1.0' },
                source: { type: 'uploaded-package', filename: 'plugin.tgz', checksum: 'sha256:abc', format: 'tgz' },
                positions: ['hub'],
                targets: [{
                    target: { scope: 'hub', runtime: 'hub', active: true },
                    runtime: 'hub',
                    required: true,
                    compatible: true,
                    status: 'compatible',
                    action: 'overwrite'
                }],
                warnings: [],
                blockingErrors: []
            }
        }))
        vi.doMock('@/api/pluginAdmin', () => ({
            getRemotePlugin: vi.fn(),
            getRemotePlugins: vi.fn(),
            getRemotePluginMarketplace,
            getRemotePluginMarketplaceEntry: vi.fn(),
            refreshRemotePluginMarketplace: vi.fn(),
            createRemoteMarketplaceInstallPlan,
            updateRemotePluginConfig: vi.fn(),
            reloadRemotePlugins: vi.fn(),
            installRemoteLocalPlugin: vi.fn(),
            createRemotePluginInstallPlan: vi.fn(),
            executeRemotePluginInstallPlan: vi.fn()
        }))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['marketplace', 'list'])
        expect(logs.join('\n')).toContain('INSTALLED')
        expect(logs.join('\n')).toContain('update')

        await handlePluginsCommand(['marketplace', 'update', 'com.market.plugin', '--dry-run'])
        expect(createRemoteMarketplaceInstallPlan).toHaveBeenCalledWith('test-token', 'com.market.plugin', expect.objectContaining({
            overwrite: true
        }), 120000)
    })

    it('gets and sets remote scoped config with --target', async () => {
        process.env.CLI_API_TOKEN = 'test-token'
        const getRemotePlugin = vi.fn(async () => ({
            plugin: {
                id: 'com.example.plugin',
                config: { label: 'old' },
                configScope: 'runner:runner-1:com.example.plugin',
                configMetadata: {
                    scope: 'runner:runner-1:com.example.plugin',
                    pluginId: 'com.example.plugin',
                    runtime: 'runner',
                    target: { scope: 'runner:runner-1', runtime: 'runner', machineId: 'runner-1', active: true },
                    config: { label: 'old' },
                    source: 'scoped'
                }
            }
        }))
        const updateRemotePluginConfig = vi.fn(async () => ({ ok: true, results: [], plugins: [] }))
        vi.doMock('@/api/pluginAdmin', () => ({
            getRemotePlugin,
            getRemotePlugins: vi.fn(),
            getRemotePluginMarketplace: vi.fn(),
            getRemotePluginMarketplaceEntry: vi.fn(),
            refreshRemotePluginMarketplace: vi.fn(),
            createRemoteMarketplaceInstallPlan: vi.fn(),
            updateRemotePluginConfig,
            reloadRemotePlugins: vi.fn(),
            installRemoteLocalPlugin: vi.fn(),
            installRemotePackagePlugin: vi.fn()
        }))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['config', 'get', 'com.example.plugin', '--target', 'runner:runner-1', '--json'])
        await handlePluginsCommand(['config', 'set', 'com.example.plugin', 'label', '"new"', '--target', 'runner:runner-1', '--json'])

        expect(getRemotePlugin).toHaveBeenCalledWith('test-token', 'com.example.plugin', 5000, 'runner:runner-1')
        expect(updateRemotePluginConfig).toHaveBeenCalledWith('test-token', 'com.example.plugin', { config: { label: 'new' } }, 5000, 'runner:runner-1')
        expect(logs.join('\n')).not.toContain('secret-value')
    })

    it('passes --target to remote reload without treating the target value as a plugin id', async () => {
        process.env.CLI_API_TOKEN = 'test-token'
        const reloadRemotePlugins = vi.fn(async () => ({ ok: true, results: [], plugins: [] }))
        vi.doMock('@/api/pluginAdmin', () => ({
            getRemotePlugin: vi.fn(),
            getRemotePlugins: vi.fn(),
            getRemotePluginMarketplace: vi.fn(),
            getRemotePluginMarketplaceEntry: vi.fn(),
            refreshRemotePluginMarketplace: vi.fn(),
            createRemoteMarketplaceInstallPlan: vi.fn(),
            updateRemotePluginConfig: vi.fn(),
            reloadRemotePlugins,
            installRemoteLocalPlugin: vi.fn(),
            installRemotePackagePlugin: vi.fn()
        }))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['reload', '--target', 'runner:runner-1', '--json'])

        expect(reloadRemotePlugins).toHaveBeenCalledWith('test-token', undefined, 5000, 'runner:runner-1')
    })

    it('redacts config-shaped secrets when printing inspect and config output', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot, { permissions: { secrets: ['PLUGIN_TOKEN'] } })
        writeFileSync(join(hapiHome, 'plugins.json'), JSON.stringify({
            enabled: {
                'com.example.plugin': {
                    enabled: true,
                    config: {
                        url: 'https://example.test',
                        PLUGIN_TOKEN: 'secret-value',
                        nested: { webhookToken: 'nested-secret', apiKey: 'api-key-secret' }
                    }
                }
            }
        }, null, 2))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['inspect', 'com.example.plugin', '--json'])
        await handlePluginsCommand(['config', 'get', 'com.example.plugin', '--json'])

        const output = logs.join('\n')
        expect(output).not.toContain('secret-value')
        expect(output).not.toContain('nested-secret')
        expect(output).not.toContain('api-key-secret')
        expect(output).toContain('[REDACTED]')
    })
})
