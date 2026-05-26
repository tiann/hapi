import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Session } from '../sync/syncEngine'
import { HubPluginManager } from './pluginManager'
import { writePluginState } from '@hapi/protocol/plugins/foundation'
import {
    HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID,
    HAPI_SCHEDULE_SEND_PLUGIN_ID,
    HAPI_SERVERCHAN_NOTIFIER_PLUGIN_ID,
    bundledFirstPartyPlugins
} from '@hapi/protocol/plugins/bundledCore'
import { bundledExamplePlugins } from '@hapi/protocol/plugins/bundledExamples'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type JsonRecord = Record<string, unknown>

function createSession(): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: { path: '/tmp/project', host: 'host', flavor: 'codex' },
        metadataVersion: 0,
        agentState: { requests: {} },
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null
    }
}

function readJsonl(file: string): JsonRecord[] {
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JsonRecord)
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'com.example.plugin',
        name: 'Plugin',
        version: '0.1.0',
        pluginApiVersion: '0.1',
        runtimes: { hub: { entry: 'dist/hub.js' } },
        contributions: { hub: { notificationChannels: [{ id: 'test', displayName: 'Test' }] } },
        ...overrides
    }
}

function writeManifest(root: string, value: Record<string, unknown>): void {
    writeFileSync(join(root, 'hapi.plugin.json'), JSON.stringify(value, null, 2))
}

function writePlugin(root: string, source: string): void {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'hub.js'), source)
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

describe('HubPluginManager', () => {
    let testDir: string
    let hapiHome: string
    let pluginRoot: string
    let logFile: string

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'hapi-plugin-manager-'))
        hapiHome = join(testDir, 'hapi-home')
        pluginRoot = join(hapiHome, 'plugins', 'com.example.plugin')
        logFile = join(testDir, 'events.jsonl')
        mkdirSync(pluginRoot, { recursive: true })
    })

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true })
    })

    it('activates enabled plugins and disables them without a Hub restart', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            const write = (value) => appendFileSync(log, JSON.stringify(value) + '\\n');
            export function activate(ctx) {
                write({ type: 'activate', config: ctx.config.get('label') });
                ctx.notifications.registerChannel({
                    async send(event) { write({ type: 'send', eventType: event.type, label: ctx.config.get('label') }); },
                    async dispose() { write({ type: 'dispose', label: ctx.config.get('label') }); }
                });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true, config: { label: 'v1' } } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.disablePlugin('com.example.plugin')
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.dispose()

        const events = readJsonl(logFile)
        expect(events.filter((event) => event.type === 'send')).toHaveLength(1)
        expect(events).toContainEqual({ type: 'dispose', label: 'v1' })
        expect(manager.listPlugins()[0]?.active).toBe(false)
    })

    it('reloads changed config and sends with the new active instance', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            const write = (value) => appendFileSync(log, JSON.stringify(value) + '\\n');
            export function activate(ctx) {
                ctx.notifications.registerChannel({
                    async send(event) { write({ type: 'send', label: ctx.config.get('label') }); },
                    async dispose() { write({ type: 'dispose', label: ctx.config.get('label') }); }
                });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true, config: { label: 'v1' } } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        await manager.getNotificationChannel().sendReady(createSession())
        const result = await manager.updatePluginConfig('com.example.plugin', { label: 'v2' })
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.dispose()

        expect(result.results[0]?.action).toBe('reloaded')
        expect(readJsonl(logFile).filter((event) => event.type === 'send').map((event) => event.label)).toEqual(['v1', 'v2'])
    })

    it('sends notification tests only through the selected plugin', async () => {
        const otherRoot = join(hapiHome, 'plugins', 'com.example.other')
        mkdirSync(otherRoot, { recursive: true })
        const pluginSource = `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({
                    async send(event) {
                        appendFileSync(log, JSON.stringify({ pluginId: ctx.pluginId, eventType: event.type, namespace: event.session.namespace }) + '\\n');
                    }
                });
            }
        `
        writePlugin(pluginRoot, pluginSource)
        writeManifest(pluginRoot, manifest())
        writePlugin(otherRoot, pluginSource)
        writeManifest(otherRoot, manifest({ id: 'com.example.other', name: 'Other Plugin' }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: {
                'com.example.plugin': { enabled: true },
                'com.example.other': { enabled: true }
            }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        const result = await manager.testNotification('com.example.plugin', 'default')
        await manager.dispose()

        expect(result.channels).toBe(1)
        expect(readJsonl(logFile)).toEqual([
            { pluginId: 'com.example.plugin', eventType: 'test', namespace: 'default' }
        ])
    })

    it('uses Hub scoped config without overwriting Runner scoped config', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                appendFileSync(log, JSON.stringify({ label: ctx.config.get('label') }) + '\\n');
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: {
                'com.example.plugin': {
                    enabled: true,
                    scopedConfig: {
                        'hub:com.example.plugin': { config: { label: 'Hub' }, updatedAt: 1 },
                        'runner:runner-1:com.example.plugin': { config: { label: 'Runner' }, updatedAt: 2 }
                    }
                }
            }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()

        expect(readJsonl(logFile)).toContainEqual({ label: 'Hub' })
        expect(manager.getPlugin('com.example.plugin')?.configMetadata).toMatchObject({
            scope: 'hub:com.example.plugin',
            source: 'scoped',
            config: { label: 'Hub' }
        })

        await manager.updatePluginConfig('com.example.plugin', { label: 'Hub updated' }, false)
        await manager.dispose()
        const state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, { scopedConfig: Record<string, { config: Record<string, unknown> }> }> }
        expect(state.enabled['com.example.plugin']?.scopedConfig['runner:runner-1:com.example.plugin']?.config).toEqual({ label: 'Runner' })
        expect(state.enabled['com.example.plugin']?.scopedConfig['hub:com.example.plugin']?.config).toEqual({ label: 'Hub updated' })
    })

    it('reports Hub secret status and missing-secret diagnostics without leaking values', async () => {
        writePlugin(pluginRoot, 'export function activate() {}')
        writeManifest(pluginRoot, manifest({ permissions: { secrets: ['PLUGIN_TOKEN'] } }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })
        const managerWithSecret = new HubPluginManager({ hapiHome, watch: false, env: { PLUGIN_TOKEN: 'hub-secret-value' } })
        await managerWithSecret.start()
        const detail = managerWithSecret.getPlugin('com.example.plugin')

        expect(detail?.permissions.secrets[0]).toMatchObject({
            name: 'PLUGIN_TOKEN',
            present: true,
            required: true,
            target: { scope: 'hub' },
            configScope: 'hub:com.example.plugin'
        })
        expect(JSON.stringify(detail)).not.toContain('hub-secret-value')
        await managerWithSecret.dispose()

        const managerMissingSecret = new HubPluginManager({ hapiHome, watch: false, env: {} })
        await managerMissingSecret.start()
        expect(managerMissingSecret.getDiagnostics()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'com.example.plugin',
                code: 'missing-secret'
            })
        ]))
        expect(managerMissingSecret.getDiagnostics()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'plugin-secret-missing' })
        ]))
        expect(JSON.stringify(managerMissingSecret.getDiagnostics())).not.toContain('hub-secret-value')
        await managerMissingSecret.dispose()
    })

    it('keeps the previous active instance when reload activation fails', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() { appendFileSync(log, JSON.stringify({ type: 'old-send' }) + '\\n'); } });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false, env: { PLUGIN_SECRET: 'super-secret' } })
        await manager.start()
        await sleep(5)
        writePlugin(pluginRoot, `export function activate() { throw new Error('boom super-secret'); }`)
        writeManifest(pluginRoot, manifest({ version: '0.1.1', permissions: { secrets: ['PLUGIN_SECRET'] } }))
        const result = await manager.reload('com.example.plugin')
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.dispose()

        expect(result.results[0]?.action).toBe('kept-previous')
        expect(result.results[0]?.status).toBe('reload-failed')
        expect(JSON.stringify(result)).not.toContain('super-secret')
        expect(readJsonl(logFile)).toContainEqual({ type: 'old-send' })
    })

    it('disposes a Hub plugin activated while shutdown is requested', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export async function activate(ctx) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                ctx.notifications.registerChannel({
                    async send() {},
                    async dispose() { appendFileSync(log, 'dispose-race\\n'); }
                });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })
        const manager = new HubPluginManager({ hapiHome, watch: false })

        const reload = manager.start()
        await sleep(5)
        await manager.dispose()
        await reload

        expect(manager.listPlugins()[0]?.active).not.toBe(true)
        expect(readFileSync(logFile, 'utf8')).toContain('dispose-race')
    })

    it('does not import Runner-only runtime entries in the Hub process', async () => {
        mkdirSync(join(pluginRoot, 'dist'), { recursive: true })
        writeFileSync(join(pluginRoot, 'dist', 'runner.js'), 'throw new Error("Hub must not import Runner runtime")')
        writeManifest(pluginRoot, manifest({
            runtimes: { runner: { entry: 'dist/runner.js' } },
            contributions: { runner: { environmentProviders: [{ id: 'env' }] } }
        }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        const result = await manager.start()
        await manager.dispose()

        expect(result.ok).toBe(true)
        expect(manager.listPlugins()[0]).toMatchObject({ id: 'com.example.plugin', status: 'enabled', active: false, runtimes: { runner: { entry: 'dist/runner.js', active: false } } })
    })

    it('does not import disabled or invalid plugins during reload', async () => {
        writePlugin(pluginRoot, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(logFile)}, 'imported'); export function activate() {}`)
        writeManifest(pluginRoot, manifest({ id: 'bad/id' }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'bad/id': { enabled: true } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        await Promise.all([manager.reload(), manager.reload()])
        await manager.dispose()

        expect(existsSync(logFile)).toBe(false)
        expect(manager.listPlugins()[0]?.status).toBe('invalid')
    })

    it('reports incompatible reloads as not ok and refuses enablement', async () => {
        writePlugin(pluginRoot, 'export function activate() {}')
        writeManifest(pluginRoot, manifest({ compatibility: { os: ['darwin'] } }))

        const manager = new HubPluginManager({ hapiHome, watch: false })
        const result = await manager.start()
        await expect(manager.enablePlugin('com.example.plugin')).rejects.toThrow('cannot be enabled')
        await manager.dispose()

        expect(result.ok).toBe(false)
        expect(result.results[0]?.status).toBe('incompatible')
    })

    it('marks unsupported declared Hub extension points incompatible before activation', async () => {
        writePlugin(pluginRoot, 'export function activate() {}')
        writeManifest(pluginRoot, manifest({
            compatibility: {
                hub: { extensionPoints: ['hub.action'] }
            }
        }))

        const manager = new HubPluginManager({ hapiHome, watch: false })
        const result = await manager.start()
        await expect(manager.enablePlugin('com.example.plugin')).rejects.toThrow('cannot be enabled')
        await manager.dispose()

        expect(result.ok).toBe(false)
        expect(result.results[0]).toMatchObject({ status: 'incompatible' })
        expect(JSON.stringify(manager.listPlugins())).toContain('hub.action')
    })

    it('discovers bundled example plugins when enabled for the Hub manager', async () => {
        const manager = new HubPluginManager({ hapiHome, watch: false, includeBundledExamples: true })
        await manager.start()
        const plugins = manager.listPlugins()
        await manager.dispose()

        expect(plugins.map((plugin) => plugin.id).sort()).toEqual(bundledExamplePlugins.map((plugin) => plugin.manifest.id).sort())
        expect(plugins.every((plugin) => plugin.source === 'bundled')).toBe(true)
        expect(plugins.find((plugin) => plugin.id === 'com.hapi.examples.notification-logger')).toMatchObject({
            enabled: false,
            active: false,
            install: { sourceType: 'bundled' }
        })
        expect(plugins.map((plugin) => plugin.id)).not.toEqual(expect.arrayContaining([
            'com.hapi.examples.voice-provider-stub',
            'com.hapi.examples.deployment-pack-stub',
            'com.hapi.examples.mcp-bridge-stub'
        ]))
    })

    it('seeds only Schedule Send as the default-installed first-party Hub plugin', async () => {
        const manager = new HubPluginManager({ hapiHome, watch: false, includeBundledCore: true })
        await manager.start()
        const plugins = manager.listPlugins()
        const webContributions = manager.collectWebContributions()

        expect(plugins.map((plugin) => plugin.id)).toEqual([HAPI_SCHEDULE_SEND_PLUGIN_ID])
        expect(plugins.find((plugin) => plugin.id === HAPI_SERVERCHAN_NOTIFIER_PLUGIN_ID)).toBeUndefined()
        expect(plugins.find((plugin) => plugin.id === HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID)).toBeUndefined()
        expect(plugins.find((plugin) => plugin.id === HAPI_SCHEDULE_SEND_PLUGIN_ID)).toMatchObject({
            source: 'user-home',
            enabled: true,
            active: true,
            install: { sourceType: 'user-home' }
        })
        expect(webContributions).toEqual([
            expect.objectContaining({
                pluginId: HAPI_SCHEDULE_SEND_PLUGIN_ID,
                contributions: expect.objectContaining({
                    composerActions: [expect.objectContaining({ id: 'schedule-send', kind: 'pluginMessageAction' })]
                })
            })
        ])
        expect(manager.collectCapabilities()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: HAPI_SCHEDULE_SEND_PLUGIN_ID,
                capabilityId: 'schedule-send',
                kind: 'chat.composer.messageAction',
                status: 'ready'
            })
        ]))
        expect(manager.collectCapabilities()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ pluginId: HAPI_SERVERCHAN_NOTIFIER_PLUGIN_ID }),
            expect.objectContaining({ pluginId: HAPI_RUNNER_LAUNCH_PRESETS_PLUGIN_ID })
        ]))
        expect(manager.collectContributionStates()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: HAPI_SCHEDULE_SEND_PLUGIN_ID,
                contributionType: 'messageAction',
                contributionId: 'schedule-send',
                registered: true,
                active: true
            })
        ]))

        await manager.disablePlugin(HAPI_SCHEDULE_SEND_PLUGIN_ID)
        expect(manager.getPlugin(HAPI_SCHEDULE_SEND_PLUGIN_ID)).toMatchObject({
            enabled: false,
            status: 'disabled'
        })
        expect(manager.collectWebContributions()).toEqual([])
        await manager.dispose()
    })

    it('respects the bundled example disable flag for the Hub manager', async () => {
        const manager = new HubPluginManager({
            hapiHome,
            watch: false,
            includeBundledCore: true,
            includeBundledExamples: true,
            env: { HAPI_DISABLE_BUNDLED_EXAMPLE_PLUGINS: '1' }
        })
        await manager.start()
        const plugins = manager.listPlugins()
        await manager.dispose()

        expect(plugins.map((plugin) => plugin.id)).not.toContain('com.hapi.examples.notification-logger')
        expect(plugins.map((plugin) => plugin.id)).toContain(HAPI_SCHEDULE_SEND_PLUGIN_ID)
    })

    it('activates and protects bundled Hub example plugins from deletion', async () => {
        const manager = new HubPluginManager({ hapiHome, watch: false, includeBundledExamples: true })
        await manager.start()
        const result = await manager.enablePlugin('com.hapi.examples.notification-logger', { prefix: '[test-example]' })
        await manager.getNotificationChannel().sendReady(createSession())

        expect(result.ok).toBe(true)
        expect(manager.getPlugin('com.hapi.examples.notification-logger')).toMatchObject({
            source: 'bundled',
            status: 'active',
            active: true
        })
        await expect(manager.deletePlugin('com.hapi.examples.notification-logger')).rejects.toThrow('cannot be deleted')
        await manager.dispose()
    })

    it('redacts declared secrets from Hub message action failures', async () => {
        writeManifest(pluginRoot, manifest({
            permissions: { secrets: ['PLUGIN_TOKEN'] },
            contributions: {
                hub: {
                    messageActions: [{ id: 'secret-action', displayName: 'Secret action' }]
                }
            }
        }))
        writePlugin(pluginRoot, `
            export function activate(ctx) {
                ctx.messages.registerAction({
                    id: 'secret-action',
                    kind: 'chat.composer.messageAction',
                    plan() {
                        return { ok: false, code: 'secret-error', message: 'failed with super-secret-value' };
                    }
                });
            }
        `)
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })
        const manager = new HubPluginManager({ hapiHome, watch: false, env: { PLUGIN_TOKEN: 'super-secret-value' } })
        await manager.start()

        const result = await manager.planMessageAction({
            pluginId: 'com.example.plugin',
            actionId: 'secret-action',
            namespace: 'default',
            session: createSession(),
            text: 'hello',
            attachments: [],
            payload: {}
        })

        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('expected message action failure')
        expect(result.message).toContain('[REDACTED]')
        expect(result.message).not.toContain('super-secret-value')
        await manager.dispose()
    })

    it('does not self-trigger bundled example watch reloads when examples are unchanged', async () => {
        const manager = new HubPluginManager({ hapiHome, watch: true, watchDebounceMs: 20, includeBundledExamples: true })
        await manager.start()
        await manager.enablePlugin('com.hapi.examples.notification-logger', { prefix: '[watch-test]' })
        const loadedAt = manager.getPlugin('com.hapi.examples.notification-logger')?.updatedAt
        await sleep(250)
        const afterWatchWindow = manager.getPlugin('com.hapi.examples.notification-logger')?.updatedAt
        await manager.dispose()

        expect(afterWatchWindow).toBe(loadedAt)
    })

    it('activates installed ServerChan notifier with filters, timeout, and secret redaction', async () => {
        const calls: Array<{ url: string; body: URLSearchParams }> = []
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            const request = url instanceof Request ? url : new Request(url instanceof URL ? url.href : url, init)
            calls.push({
                url: request.url,
                body: new URLSearchParams(await request.clone().text())
            })
            return new Response('ok', { status: 200 })
        }) as typeof fetch

        try {
            installBundledFirstPartyPlugin(hapiHome, HAPI_SERVERCHAN_NOTIFIER_PLUGIN_ID)
            const manager = new HubPluginManager({
                hapiHome,
                watch: false,
                includeBundledCore: true,
                publicUrl: 'https://hapi.example.test',
                env: { SERVERCHAN_SENDKEY: 'SCT_SECRET_VALUE' }
            })
            await manager.start()
            await manager.enablePlugin(HAPI_SERVERCHAN_NOTIFIER_PLUGIN_ID, {
                titlePrefix: 'HAPI Test',
                namespaces: ['default'],
                sessionPathPrefixes: ['/tmp/project'],
                timeoutMs: 5000
            })

            const unmatched = createSession()
            const unmatchedMetadata = unmatched.metadata!
            unmatched.metadata = { ...unmatchedMetadata, host: unmatchedMetadata.host, path: '/tmp/project2' }
            await manager.getNotificationChannel().sendReady(unmatched)
            await manager.getNotificationChannel().sendReady(createSession())
            const testResult = await manager.testNotification(HAPI_SERVERCHAN_NOTIFIER_PLUGIN_ID, 'default')
            await manager.dispose()

            expect(testResult.channels).toBe(1)
            expect(calls).toHaveLength(2)
            expect(calls[0]?.url).toBe('https://sctapi.ftqq.com/SCT_SECRET_VALUE.send')
            expect(calls[0]?.body.get('title')).toBe('HAPI Test Ready for input')
            expect(calls[0]?.body.get('desp')).toContain('https://hapi.example.test/sessions/session-1')
            expect(calls[1]?.body.get('title')).toBe('HAPI Test Test notification')
            expect(calls[1]?.body.get('desp')).toContain('Plugin notification test')
            expect(JSON.stringify(manager.getPlugin(HAPI_SERVERCHAN_NOTIFIER_PLUGIN_ID))).not.toContain('SCT_SECRET_VALUE')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('rejects config updates that would persist secrets', async () => {
        writePlugin(pluginRoot, 'export function activate() {}')
        writeManifest(pluginRoot, manifest({ permissions: { secrets: ['PLUGIN_TOKEN'] } }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true, config: { label: 'safe' } } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        await expect(manager.updatePluginConfig('com.example.plugin', { nested: { PLUGIN_TOKEN: 'secret-value' } })).rejects.toThrow('declared secret')
        await expect(manager.updatePluginConfig('com.example.plugin', { nested: { webhookToken: 'secret-value' } })).rejects.toThrow('secret-like field')
        await expect(manager.updatePluginConfig('com.example.plugin', { api: { key: '[REDACTED]' } })).rejects.toThrow('redacted placeholder')
        await manager.dispose()

        const state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, { config: Record<string, unknown> }> }
        expect(JSON.stringify(state)).not.toContain('secret-value')
        expect(state.enabled['com.example.plugin']?.config).toEqual({ label: 'safe' })
    })


    it('redacts existing secret-shaped config values in detail views', async () => {
        writePlugin(pluginRoot, 'export function activate() {}')
        writeManifest(pluginRoot, manifest({ permissions: { secrets: ['PLUGIN_TOKEN'] } }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: {
                'com.example.plugin': {
                    enabled: true,
                    config: {
                        url: 'https://example.test',
                        nested: { PLUGIN_TOKEN: 'declared-secret', apiKey: 'api-key-secret' }
                    }
                }
            }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        const detail = manager.getPlugin('com.example.plugin')
        await manager.dispose()

        expect(JSON.stringify(detail)).not.toContain('declared-secret')
        expect(JSON.stringify(detail)).not.toContain('api-key-secret')
        expect(detail?.config).toEqual({ url: 'https://example.test', nested: { PLUGIN_TOKEN: '[REDACTED]', apiKey: '[REDACTED]' } })
    })

    it('deletes user-home plugin files and removes saved state', async () => {
        writePlugin(pluginRoot, 'export function activate(ctx) { ctx.notifications.registerChannel({ async dispose() {} }) }')
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true, config: { label: 'v1' } } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        expect(manager.listPlugins()[0]?.active).toBe(true)
        const result = await manager.deletePlugin('com.example.plugin')
        await manager.dispose()

        expect(result.deleted).toBe(true)
        expect(result.plugins.some((entry) => entry.id === 'com.example.plugin')).toBe(false)
        expect(existsSync(pluginRoot)).toBe(false)
        const state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, unknown> }
        expect(state.enabled['com.example.plugin']).toBeUndefined()
    })

    it('installs local plugin directories into the user plugin directory', async () => {
        const sourceRoot = join(testDir, 'source-plugin')
        mkdirSync(sourceRoot, { recursive: true })
        writePlugin(sourceRoot, 'export function activate() {}')
        writeManifest(sourceRoot, manifest({ id: 'com.local.installed', name: 'Local Plugin' }))

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        const result = await manager.installLocalPlugin(sourceRoot, { reload: true })
        await manager.dispose()

        expect(result.action).toBe('installed')
        expect(result.pluginId).toBe('com.local.installed')
        expect(result.plugin?.enabled).toBe(false)
        expect(existsSync(join(hapiHome, 'plugins', 'com.local.installed', 'hapi.plugin.json'))).toBe(true)
    })

    it('lists Hub-local directories for plugin install browsing', async () => {
        writePlugin(pluginRoot, 'export function activate() {}')
        writeManifest(pluginRoot, manifest())
        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        const result = await manager.listLocalDirectory(join(hapiHome, 'plugins'))
        await manager.dispose()

        expect(result.success).toBe(true)
        expect(result.entries?.find((entry) => entry.name === 'com.example.plugin')?.hasPluginManifest).toBe(true)
    })

    it('reloads changed entry files through explicit reload', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() { appendFileSync(log, JSON.stringify({ version: 'v1' }) + '\\n'); } });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        await manager.getNotificationChannel().sendReady(createSession())
        await sleep(5)
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() { appendFileSync(log, JSON.stringify({ version: 'v2' }) + '\\n'); } });
            }
        `)
        const result = await manager.reload('com.example.plugin')
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.dispose()

        expect(result.results[0]?.action).toBe('reloaded')
        expect(readJsonl(logFile).map((event) => event.version)).toEqual(['v1', 'v2'])
    })

    it('watches plugins.json and applies debounced reloads when available', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send(event) { appendFileSync(log, JSON.stringify({ type: 'send', eventType: event.type }) + '\\n'); } });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: false } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: true, watchDebounceMs: 20 })
        await manager.start()
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })
        await sleep(250)
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.dispose()

        expect(readJsonl(logFile)).toContainEqual({ type: 'send', eventType: 'ready' })
    })

    it('ignores data-dir churn such as sqlite files when watching plugins', async () => {
        class CountingHubPluginManager extends HubPluginManager {
            watchReloads = 0

            override async reload(...args: Parameters<HubPluginManager['reload']>): ReturnType<HubPluginManager['reload']> {
                if (args[1] === 'watch') {
                    this.watchReloads += 1
                }
                return await super.reload(...args)
            }
        }

        writePlugin(pluginRoot, `
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() {} });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })

        const manager = new CountingHubPluginManager({ hapiHome, watch: true, watchDebounceMs: 20 })
        await manager.start()
        await sleep(50)
        writeFileSync(join(hapiHome, 'hapi.db'), 'sqlite-main')
        writeFileSync(join(hapiHome, 'hapi.db-wal'), 'sqlite-wal')
        writeFileSync(join(hapiHome, 'runner.state.json'), '{}')
        await sleep(150)
        await manager.dispose()

        expect(manager.watchReloads).toBe(0)
    })

    it('watches nested hub entry directory changes and reloads them when available', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() { appendFileSync(log, JSON.stringify({ version: 'v1' }) + '\\n'); } });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: true, watchDebounceMs: 20 })
        await manager.start()
        await manager.getNotificationChannel().sendReady(createSession())
        await sleep(5)
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() { appendFileSync(log, JSON.stringify({ version: 'v2' }) + '\\n'); } });
            }
        `)
        await sleep(300)
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.dispose()

        expect(readJsonl(logFile).map((event) => event.version)).toEqual(['v1', 'v2'])
    })

})
