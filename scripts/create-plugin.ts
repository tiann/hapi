#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { HAPI_PLUGIN_API_VERSION } from '@hapi/protocol/plugins'

const repoRoot = join(import.meta.dir, '..')
const pluginsRoot = join(repoRoot, 'plugins')

export type PluginTemplateName = 'hub-notification' | 'runner-env' | 'web-descriptor'

export interface CreatePluginArgs {
    pluginId: string
    template: PluginTemplateName
    dir: string
    name?: string
    force: boolean
}

export interface CreatePluginResult {
    pluginId: string
    name: string
    template: PluginTemplateName
    dir: string
    files: string[]
}

type PluginFile = {
    path: string
    content: string
}

type TemplateContext = {
    pluginId: string
    shortId: string
    name: string
    description: string
    pluginApiRange: string
}

type TemplateDefinition = {
    manifest(ctx: TemplateContext): Record<string, unknown>
    runtimeFiles(ctx: TemplateContext): PluginFile[]
    marketplace(ctx: TemplateContext): Record<string, unknown>
}

const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const templateNames = ['hub-notification', 'runner-env', 'web-descriptor'] as const

function usage(): string {
    return [
        'Usage: bun scripts/create-plugin.ts <plugin-id> --template hub-notification|runner-env|web-descriptor [--dir <path>] [--name <display name>] [--force]',
        'Example: bun run plugin:create -- com.example.my-plugin --template hub-notification'
    ].join('\n')
}

function toPosix(path: string): string {
    return path.split(sep).join('/')
}

function isInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

async function canSafelyReplaceDirectory(path: string): Promise<boolean> {
    if (existsSync(join(path, 'hapi.plugin.json'))) return true
    const entries = await readdir(path).catch(() => null)
    return Array.isArray(entries) && entries.length === 0
}

function ensureSupportedTemplate(value: string): PluginTemplateName {
    if ((templateNames as readonly string[]).includes(value)) return value as PluginTemplateName
    throw new Error(`Unsupported template "${value}". Expected one of: ${templateNames.join(', ')}`)
}

function optionValue(args: string[], index: number, name: string): string {
    const value = args[index + 1]
    if (!value || value.startsWith('-')) {
        throw new Error(`${name} requires a value.`)
    }
    return value
}

function defaultPluginName(pluginId: string): string {
    const tail = pluginId.split('.').filter(Boolean).at(-1) ?? pluginId
    return tail
        .split(/[-_]+/)
        .filter(Boolean)
        .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
        .join(' ') || pluginId
}

function recommendedPluginApiRange(pluginApiVersion: string): string {
    const [majorRaw, minorRaw] = pluginApiVersion.split('.')
    const major = Number(majorRaw)
    const minor = Number(minorRaw)
    const upper = Number.isFinite(major) && Number.isFinite(minor)
        ? `<${major}.${minor + 1}`
        : `>${pluginApiVersion}`
    return `>=${pluginApiVersion} ${upper}`
}

function contributionId(pluginId: string): string {
    return pluginId.split('.').filter(Boolean).at(-1) ?? pluginId
}

function stableJson(value: unknown): string {
    return `${JSON.stringify(value, null, 4)}\n`
}

function jsString(value: string): string {
    return JSON.stringify(value)
}

function hubNotificationTemplate(): TemplateDefinition {
    return {
        manifest: (ctx) => ({
            id: ctx.pluginId,
            version: '0.1.0',
            name: ctx.name,
            description: ctx.description,
            pluginApiVersion: HAPI_PLUGIN_API_VERSION,
            capabilities: [{
                id: ctx.shortId,
                kind: 'notification.channel',
                displayName: ctx.name,
                description: 'Registers a Hub notification channel.',
                parts: {
                    hub: {
                        required: true,
                        contributions: [{ type: 'notificationChannel', id: ctx.shortId }]
                    }
                }
            }],
            runtimes: {
                hub: { entry: 'src/hub.js' }
            },
            contributions: {
                hub: {
                    notificationChannels: [{
                        id: ctx.shortId,
                        displayName: ctx.name
                    }]
                }
            },
            compatibility: {
                pluginApi: ctx.pluginApiRange,
                hub: {
                    extensionPoints: ['hub.notificationChannel']
                }
            }
        }),
        runtimeFiles: (ctx) => [{
            path: 'src/hub.js',
            content: `// @ts-check\n\n/** @param {import('@hapi/protocol/plugins').HubPluginContext} ctx */\nexport function activate(ctx) {\n    ctx.notifications.registerChannel({\n        async send(event) {\n            ctx.logger.info(${jsString(`${ctx.name} received notification: %s`)}, event.type)\n        }\n    })\n}\n`
        }],
        marketplace: (ctx) => ({
            name: ctx.name,
            description: ctx.description,
            repo: 'tiann/hapi',
            categories: ['notification'],
            keywords: ['notification', 'plugin'],
            runtimes: ['hub'],
            capabilities: [{ kind: 'notification.channel', label: ctx.name }]
        })
    }
}

function runnerEnvTemplate(): TemplateDefinition {
    return {
        manifest: (ctx) => ({
            id: ctx.pluginId,
            version: '0.1.0',
            name: ctx.name,
            description: ctx.description,
            pluginApiVersion: HAPI_PLUGIN_API_VERSION,
            capabilities: [{
                id: ctx.shortId,
                kind: 'runner.spawnExtension',
                displayName: ctx.name,
                description: 'Adds Runner environment values before agent spawn.',
                parts: {
                    runner: {
                        required: true,
                        target: 'selected-runner',
                        contributions: [{ type: 'environmentProvider', id: ctx.shortId }]
                    }
                }
            }],
            runtimes: {
                runner: { entry: 'src/runner.js' }
            },
            contributions: {
                runner: {
                    environmentProviders: [{
                        id: ctx.shortId,
                        displayName: ctx.name,
                        description: 'Provides a sample environment variable for spawned agents.'
                    }]
                }
            },
            compatibility: {
                pluginApi: ctx.pluginApiRange,
                runner: {
                    extensionPoints: ['runner.environmentProvider']
                }
            },
            install: {
                runnerPlacement: 'compatible-runners',
                offlineRunnerPolicy: 'skip',
                minReadyRunnerCount: 1
            }
        }),
        runtimeFiles: (ctx) => [{
            path: 'src/runner.js',
            content: `// @ts-check\n\n/** @param {import('@hapi/protocol/plugins').RunnerPluginContext} ctx */\nexport function activate(ctx) {\n    ctx.runtime.registerEnvironmentProvider({\n        id: ${jsString(ctx.shortId)},\n        priority: 0,\n        provide(context) {\n            return {\n                env: {\n                    EXAMPLE_PLUGIN_ENABLED: '1'\n                },\n                diagnostics: [{\n                    severity: 'info',\n                    code: ${jsString(`${ctx.shortId}-applied`)},\n                    message: ${jsString(`${ctx.name} applied to `)} + context.agent\n                }]\n            }\n        }\n    })\n}\n`
        }],
        marketplace: (ctx) => ({
            name: ctx.name,
            description: ctx.description,
            repo: 'tiann/hapi',
            categories: ['runner', 'utility'],
            keywords: ['runner', 'environment', 'plugin'],
            runtimes: ['runner'],
            capabilities: [{ kind: 'runner.spawnExtension', label: ctx.name }]
        })
    }
}

function webDescriptorTemplate(): TemplateDefinition {
    return {
        manifest: (ctx) => ({
            id: ctx.pluginId,
            version: '0.1.0',
            name: ctx.name,
            description: ctx.description,
            pluginApiVersion: HAPI_PLUGIN_API_VERSION,
            capabilities: [{
                id: ctx.shortId,
                kind: 'settings.panel',
                displayName: ctx.name,
                description: 'Adds a descriptor-driven settings panel.',
                parts: {
                    web: {
                        required: true,
                        contributions: [{ type: 'settingsPanel', id: ctx.shortId }]
                    }
                }
            }],
            contributions: {
                web: {
                    settingsPanels: [{
                        id: ctx.shortId,
                        title: ctx.name,
                        description: ctx.description,
                        components: [{
                            kind: 'text',
                            tone: 'info',
                            text: `${ctx.name} is rendered from a plugin Web descriptor. No browser-side plugin JavaScript is executed.`
                        }, {
                            kind: 'schemaForm',
                            title: 'Options',
                            fields: [{
                                key: 'enabledLabel',
                                label: 'Label',
                                type: 'text',
                                defaultValue: ctx.name
                            }]
                        }]
                    }]
                }
            },
            compatibility: {
                pluginApi: ctx.pluginApiRange,
                hub: {
                    extensionPoints: ['web.settingsPanel']
                }
            }
        }),
        runtimeFiles: () => [],
        marketplace: (ctx) => ({
            name: ctx.name,
            description: ctx.description,
            repo: 'tiann/hapi',
            categories: ['utility'],
            keywords: ['web', 'settings', 'descriptor', 'plugin'],
            capabilities: [{ kind: 'settings.panel', label: ctx.name }]
        })
    }
}

const templates: Record<PluginTemplateName, TemplateDefinition> = {
    'hub-notification': hubNotificationTemplate(),
    'runner-env': runnerEnvTemplate(),
    'web-descriptor': webDescriptorTemplate()
}

export function parseCreatePluginArgs(args: string[], cwd = process.cwd()): CreatePluginArgs {
    let pluginId: string | undefined
    let template: PluginTemplateName | undefined
    let dir: string | undefined
    let name: string | undefined
    let force = false

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]
        if (arg === '--') continue
        if (arg === '--force') {
            force = true
            continue
        }
        if (arg === '--template') {
            template = ensureSupportedTemplate(optionValue(args, index, '--template'))
            index += 1
            continue
        }
        if (arg.startsWith('--template=')) {
            template = ensureSupportedTemplate(arg.slice('--template='.length))
            continue
        }
        if (arg === '--dir') {
            dir = optionValue(args, index, '--dir')
            index += 1
            continue
        }
        if (arg.startsWith('--dir=')) {
            dir = arg.slice('--dir='.length)
            continue
        }
        if (arg === '--name') {
            name = optionValue(args, index, '--name')
            index += 1
            continue
        }
        if (arg.startsWith('--name=')) {
            name = arg.slice('--name='.length)
            continue
        }
        if (arg.startsWith('-')) {
            throw new Error(`${usage()}\nUnknown option: ${arg}`)
        }
        if (pluginId) {
            throw new Error(`${usage()}\nUnexpected argument: ${arg}`)
        }
        pluginId = arg
    }

    if (!pluginId) throw new Error(usage())
    if (!pluginIdPattern.test(pluginId) || pluginId.length > 128) {
        throw new Error('Plugin id must start with an alphanumeric character and contain only alphanumeric characters, dots, underscores, or dashes.')
    }
    if (!template) throw new Error(`${usage()}\nMissing --template.`)

    const targetDir = resolve(cwd, dir ?? join('plugins', pluginId))
    return {
        pluginId,
        template,
        dir: targetDir,
        ...(name?.trim() ? { name: name.trim() } : {}),
        force
    }
}

export async function createPlugin(args: CreatePluginArgs): Promise<CreatePluginResult> {
    const targetDir = resolve(args.dir)
    if (targetDir === repoRoot || targetDir === pluginsRoot) {
        throw new Error(`Refusing to create plugin directly at ${targetDir}. Choose a plugin-specific directory.`)
    }
    if (isInside(pluginsRoot, targetDir)) {
        if (dirname(targetDir) !== pluginsRoot) {
            throw new Error('First-party plugin directories must be direct children of plugins/. Use --dir outside plugins/ for nested development paths.')
        }
        if (basename(targetDir) !== args.pluginId) {
            throw new Error('First-party plugin directory name must match the plugin id.')
        }
    }
    if (existsSync(targetDir)) {
        if (!args.force) {
            throw new Error(`Plugin directory already exists: ${targetDir}. Use --force to replace it.`)
        }
        if (!await canSafelyReplaceDirectory(targetDir)) {
            throw new Error(`Refusing to replace ${targetDir}: --force only replaces empty directories or existing plugin directories containing hapi.plugin.json.`)
        }
        await rm(targetDir, { recursive: true, force: true })
    }

    const name = args.name ?? defaultPluginName(args.pluginId)
    const ctx: TemplateContext = {
        pluginId: args.pluginId,
        shortId: contributionId(args.pluginId),
        name,
        description: `${name} HAPI plugin.`,
        pluginApiRange: recommendedPluginApiRange(HAPI_PLUGIN_API_VERSION)
    }
    const template = templates[args.template]
    const files: PluginFile[] = [
        { path: 'hapi.plugin.json', content: stableJson(template.manifest(ctx)) },
        ...template.runtimeFiles(ctx)
    ]

    if (isInside(pluginsRoot, targetDir)) {
        files.push({ path: 'hapi.marketplace.json', content: stableJson(template.marketplace(ctx)) })
    }

    for (const file of files) {
        const fullPath = join(targetDir, file.path)
        await mkdir(dirname(fullPath), { recursive: true })
        await writeFile(fullPath, file.content, 'utf8')
    }

    return {
        pluginId: args.pluginId,
        name,
        template: args.template,
        dir: targetDir,
        files: files.map((file) => file.path).sort()
    }
}

export async function runCreatePluginCli(args: string[] = process.argv.slice(2)): Promise<number> {
    let parsed: CreatePluginArgs
    try {
        parsed = parseCreatePluginArgs(args)
        const result = await createPlugin(parsed)
        console.log(`[create-plugin] created ${result.pluginId} at ${toPosix(relative(repoRoot, result.dir) || basename(result.dir))}`)
        for (const file of result.files) {
            console.log(` - ${file}`)
        }
        console.log(`[create-plugin] next: bun run plugin:validate -- ${toPosix(relative(repoRoot, result.dir) || result.dir)}`)
        return 0
    } catch (error) {
        console.error(`[create-plugin] ${error instanceof Error ? error.message : String(error)}`)
        return 1
    }
}

if (import.meta.main) {
    const exitCode = await runCreatePluginCli()
    process.exit(exitCode)
}
