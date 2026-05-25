import chalk from 'chalk'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, realpath, rm } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { configuration } from '@/configuration'
import { readSettings } from '@/persistence'
import { initializeApiUrl } from '@/ui/apiUrlInit'
import { initializeToken } from '@/ui/tokenInit'
import {
    createRemoteMarketplaceInstallPlan,
    createRemotePluginInstallPlan,
    executeRemotePluginInstallPlan,
    getRemotePlugin,
    getRemotePluginMarketplace,
    getRemotePluginMarketplaceEntry,
    getRemotePlugins,
    installRemoteLocalPlugin,
    reloadRemotePlugins,
    refreshRemotePluginMarketplace,
    updateRemotePluginConfig
} from '@/api/pluginAdmin'
import type { CommandDefinition } from './types'
import {
    applyPluginState,
    discoverPlugins,
    getPluginStateFile,
    getUserPluginsDir,
    installPluginFromDirectory,
    readPluginState,
    writePluginState,
    type DiscoveredPluginRecord
} from '@hapi/protocol/plugins/foundation'
import { assertPluginConfigSafeForPersistence, PluginTargetScopeSchema, sanitizePluginConfigForView } from '@hapi/protocol/plugins'
import { prepareBundledExamplePlugins } from '@hapi/protocol/plugins/bundledExamples'
import { seedDefaultFirstPartyPluginsAsUserPlugins } from '@hapi/protocol/plugins/bundledCore'
import type { PluginDeleteResult, PluginDiagnostic, PluginInstallAction, PluginInstallPlanResponse, PluginInstallResult, PluginListItem, PluginListResponse, PluginReloadResult, PluginStateFile, PluginTargetScope } from '@hapi/protocol/plugins'
import type { PluginMarketplaceEntryView, PluginMarketplaceInstallPlanResponse } from '@hapi/protocol/plugins/marketplace'

function hasFlag(args: string[], flag: string): boolean {
    return args.includes(flag)
}

function valueAfter(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
}

function positionalArgs(args: string[], flagsWithValues: string[] = []): string[] {
    const values: string[] = []
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]
        if (flagsWithValues.includes(arg)) {
            index += 1
            continue
        }
        if (!arg.startsWith('-')) {
            values.push(arg)
        }
    }
    return values
}

function parseTargetArg(args: string[]): PluginTargetScope | undefined {
    const raw = valueAfter(args, '--target')
    if (!raw) return undefined
    return PluginTargetScopeSchema.parse(raw)
}

function parseRunnerSelectionArg(args: string[]): { mode: 'compatible' | 'all' | 'selected'; machineIds?: string[] } | undefined {
    const raw = valueAfter(args, '--runners')
    if (!raw || raw === 'compatible') return { mode: 'compatible' }
    if (raw === 'all') return { mode: 'all' }
    const machineIds = raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.startsWith('runner:') ? entry.slice('runner:'.length) : entry)
    if (machineIds.length === 0) {
        throw new Error('--runners must be compatible, all, or a comma-separated Runner machine id list.')
    }
    return { mode: 'selected', machineIds }
}

function printInstallPlan(plan: PluginInstallPlanResponse): void {
    console.log(chalk.bold(`Install plan: ${plan.plugin.name} ${plan.plugin.version}`))
    console.log(chalk.gray(`Positions: ${plan.positions.join(', ')}`))
    for (const warning of plan.warnings) {
        console.log(chalk.yellow(`warning: ${warning}`))
    }
    for (const error of plan.blockingErrors) {
        console.log(chalk.red(`blocked: ${error}`))
    }
    for (const target of plan.targets) {
        const label = target.target.displayName ?? target.target.machineId ?? target.target.scope
        const marker = target.compatible ? chalk.green(target.action) : target.action === 'skip' ? chalk.yellow(target.action) : chalk.red(target.action)
        console.log(`${target.target.scope} (${label}): ${marker}${target.reason ? ` - ${target.reason}` : ''}`)
    }
}

function pluginId(record: DiscoveredPluginRecord): string {
    return record.manifest?.id ?? basename(record.rootPath)
}

async function loadLocalRecords(): Promise<{ records: DiscoveredPluginRecord[]; state: PluginStateFile; parseError?: string }> {
    await seedDefaultFirstPartyPluginsAsUserPlugins(configuration.happyHomeDir)
    const stateResult = await readPluginState(getPluginStateFile(configuration.happyHomeDir))
    const bundledPluginDirs = [
        ...(process.env.HAPI_ENABLE_BUNDLED_EXAMPLES === '1' && process.env.HAPI_DISABLE_BUNDLED_EXAMPLE_PLUGINS !== '1'
            ? [await prepareBundledExamplePlugins(configuration.happyHomeDir)]
            : [])
    ]
    const discovered = await discoverPlugins({
        hapiHome: configuration.happyHomeDir,
        envPluginDirs: process.env.HAPI_PLUGIN_DIRS,
        bundledPluginDirs
    })
    return {
        records: applyPluginState(discovered, stateResult.state, {
            failClosed: stateResult.failClosed,
            defaultEnabledPluginIds: []
        }),
        state: stateResult.state,
        parseError: stateResult.parseError
    }
}

function toLocalListItem(record: DiscoveredPluginRecord): PluginListItem {
    const id = pluginId(record)
    return {
        id,
        name: record.manifest?.name,
        version: record.manifest?.version,
        description: record.manifest?.description,
        display: record.manifest?.display,
        source: record.source,
        status: record.status,
        enabled: record.enabled === true,
        active: false,
        rootPath: record.rootPath,
        manifestPath: record.manifestPath,
        runtimes: {
            ...(record.manifest?.runtimes?.hub ? { hub: { entry: record.manifest.runtimes.hub.entry, active: false } } : {}),
            ...(record.manifest?.runtimes?.runner ? { runner: { entry: record.manifest.runtimes.runner.entry, active: false } } : {})
        },
        target: { scope: 'hub', runtime: 'hub', active: false, stale: true, displayName: 'Local Hub files' },
        install: record.install ?? { sourceType: record.source, version: record.manifest?.version },
        diagnostics: record.diagnostics.map((diagnostic) => ({ ...diagnostic, pluginId: id }))
    }
}

async function tryRemoteList(target?: PluginTargetScope): Promise<PluginListResponse | null> {
    try {
        await initializeApiUrl()
        if (!configuration.cliApiToken) {
            const settings = await readSettings()
            if (settings.cliApiToken) {
                configuration._setCliApiToken(settings.cliApiToken)
            }
        }
        if (!configuration.cliApiToken) {
            return null
        }
        return await getRemotePlugins(configuration.cliApiToken, 2000, target)
    } catch {
        return null
    }
}

function targetLabel(plugin: PluginListItem): string {
    if (!plugin.target) return 'local'
    if (plugin.target.scope === 'hub') return 'hub'
    return plugin.target.machineId ? `runner:${plugin.target.machineId}` : plugin.target.scope
}

function runtimeLabel(plugin: PluginListItem): string {
    const runtimes = Object.keys(plugin.runtimes)
    return runtimes.length ? runtimes.join(',') : '-'
}

function printTable(plugins: PluginListItem[]): void {
    const rows = plugins.map((plugin) => ({
        id: plugin.id,
        target: targetLabel(plugin),
        runtime: runtimeLabel(plugin),
        status: plugin.status,
        enabled: plugin.enabled ? 'yes' : 'no',
        active: plugin.active ? 'yes' : 'no',
        source: plugin.source,
        name: plugin.name ?? ''
    }))
    const widths = {
        id: Math.max(2, ...rows.map((row) => row.id.length)),
        target: Math.max(6, ...rows.map((row) => row.target.length)),
        runtime: Math.max(7, ...rows.map((row) => row.runtime.length)),
        status: Math.max(6, ...rows.map((row) => row.status.length)),
        enabled: 7,
        active: 6,
        source: Math.max(6, ...rows.map((row) => row.source.length))
    }
    console.log(`${'ID'.padEnd(widths.id)}  ${'TARGET'.padEnd(widths.target)}  ${'RUNTIME'.padEnd(widths.runtime)}  ${'STATUS'.padEnd(widths.status)}  ENABLED  ACTIVE  ${'SOURCE'.padEnd(widths.source)}  NAME`)
    for (const row of rows) {
        console.log(`${row.id.padEnd(widths.id)}  ${row.target.padEnd(widths.target)}  ${row.runtime.padEnd(widths.runtime)}  ${row.status.padEnd(widths.status)}  ${row.enabled.padEnd(widths.enabled)}  ${row.active.padEnd(widths.active)}  ${row.source.padEnd(widths.source)}  ${row.name}`)
    }
}

function latestMarketplaceRelease(entry: PluginMarketplaceEntryView): PluginMarketplaceEntryView['releases'][number] | undefined {
    return entry.latestCompatibleVersion
        ? entry.releases.find((release) => release.version === entry.latestCompatibleVersion && !release.yanked)
        : undefined
}

function marketplaceInstallStatus(entry: PluginMarketplaceEntryView): string {
    if (!entry.installed) return '-'
    if (entry.installed.yanked) return 'yanked'
    if (entry.installed.updateAvailable) return 'update'
    return 'installed'
}

function printMarketplaceTable(entries: PluginMarketplaceEntryView[]): void {
    const rows = entries.map((entry) => {
        const latest = latestMarketplaceRelease(entry)
        return {
            id: entry.id,
            version: latest?.version ?? '-',
            installed: entry.installed?.version ?? '-',
            status: marketplaceInstallStatus(entry),
            repo: entry.repo,
            categories: (entry.categories ?? []).join(',') || '-',
            name: entry.name
        }
    })
    const widths = {
        id: Math.max(2, ...rows.map((row) => row.id.length)),
        version: Math.max(7, ...rows.map((row) => row.version.length)),
        installed: Math.max(9, ...rows.map((row) => row.installed.length)),
        status: Math.max(6, ...rows.map((row) => row.status.length)),
        repo: Math.max(4, ...rows.map((row) => row.repo.length)),
        categories: Math.max(10, ...rows.map((row) => row.categories.length))
    }
    console.log(`${'ID'.padEnd(widths.id)}  ${'LATEST'.padEnd(widths.version)}  ${'INSTALLED'.padEnd(widths.installed)}  ${'STATUS'.padEnd(widths.status)}  ${'REPO'.padEnd(widths.repo)}  ${'CATEGORIES'.padEnd(widths.categories)}  NAME`)
    for (const row of rows) {
        console.log(`${row.id.padEnd(widths.id)}  ${row.version.padEnd(widths.version)}  ${row.installed.padEnd(widths.installed)}  ${row.status.padEnd(widths.status)}  ${row.repo.padEnd(widths.repo)}  ${row.categories.padEnd(widths.categories)}  ${row.name}`)
    }
}

function findRecord(records: DiscoveredPluginRecord[], id: string): DiscoveredPluginRecord | undefined {
    return records.find((record) => pluginId(record) === id || record.manifest?.id === id)
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

function printDiagnostics(diagnostics: PluginDiagnostic[]): void {
    if (diagnostics.length === 0) {
        console.log(chalk.green('No diagnostics.'))
        return
    }
    for (const diagnostic of diagnostics) {
        const color = diagnostic.severity === 'error' ? chalk.red : diagnostic.severity === 'warning' ? chalk.yellow : chalk.gray
        console.log(color(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`))
        if (diagnostic.path) {
            console.log(chalk.gray(`  ${diagnostic.path}`))
        }
    }
}

function assertLocalRecordCanBeEnabled(record: DiscoveredPluginRecord, id: string): asserts record is DiscoveredPluginRecord & { manifest: NonNullable<DiscoveredPluginRecord['manifest']> } {
    if (!record.manifest) {
        throw new Error(`Plugin not found or invalid: ${id}`)
    }
    if (['invalid', 'incompatible', 'blocked'].includes(record.status)) {
        throw new Error(`Plugin ${record.manifest.id} cannot be enabled while status is ${record.status}.`)
    }
}

async function parseConfigArg(raw: string | undefined): Promise<Record<string, unknown> | undefined> {
    if (!raw) {
        return undefined
    }
    const text = raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Config must be a JSON object.')
    }
    return parsed as Record<string, unknown>
}

function parseValue(raw: string): unknown {
    try {
        return JSON.parse(raw) as unknown
    } catch {
        return raw
    }
}

async function confirmRisk(record: DiscoveredPluginRecord, action: 'enable' | 'disable', yes: boolean): Promise<void> {
    if (yes) {
        return
    }
    if (!process.stdin.isTTY) {
        throw new Error(`Refusing to ${action} plugin in non-TTY mode without --yes.`)
    }
    console.log(chalk.yellow('This plugin will run as trusted local code inside the HAPI Hub process.'))
    console.log(chalk.yellow('Permissions are declarations for review; they are not a sandbox enforcement boundary.'))
    console.log(chalk.gray(`Plugin: ${record.manifest?.name ?? pluginId(record)} (${pluginId(record)})`))
    console.log(chalk.gray(`Entry: ${record.manifest?.runtimes?.hub?.entry ?? '(none)'}`))
    console.log(chalk.gray(`Declared network access: ${(record.manifest?.permissions?.network ?? []).join(', ') || '(none)'}`))
    console.log(chalk.gray(`Declared secrets: ${(record.manifest?.permissions?.secrets ?? []).join(', ') || '(none)'}`))
    console.log(chalk.gray('Secret values are read from environment variables and are not stored in plugins.json.'))
    const rl = readline.createInterface({ input, output })
    try {
        const answer = await rl.question(`Type ${action} to continue: `)
        if (answer.trim() !== action) {
            throw new Error('Cancelled.')
        }
    } finally {
        rl.close()
    }
}

async function confirmDelete(record: DiscoveredPluginRecord, yes: boolean): Promise<void> {
    if (yes) {
        return
    }
    if (!process.stdin.isTTY) {
        throw new Error('Refusing to delete plugin files in non-TTY mode without --yes.')
    }
    console.log(chalk.red('This will permanently delete the local plugin directory.'))
    console.log(chalk.gray(`Plugin: ${record.manifest?.name ?? pluginId(record)} (${pluginId(record)})`))
    console.log(chalk.gray(`Root: ${record.rootPath}`))
    const rl = readline.createInterface({ input, output })
    try {
        const answer = await rl.question('Type delete to continue: ')
        if (answer.trim() !== 'delete') {
            throw new Error('Cancelled.')
        }
    } finally {
        rl.close()
    }
}

async function readWritableState(): Promise<PluginStateFile> {
    const result = await readPluginState(getPluginStateFile(configuration.happyHomeDir))
    if (result.parseError) {
        throw new Error(`Cannot update plugins.json while it is invalid: ${result.parseError}`)
    }
    return result.state
}

async function maybeReload(pluginId: string | undefined, requested: boolean, json: boolean, stateSavedMessage: string): Promise<void> {
    if (!requested) {
        console.log(chalk.green(stateSavedMessage))
        console.log(chalk.gray('Run hapi plugins reload or restart hapi hub to apply.'))
        return
    }
    try {
        await initializeApiUrl()
        await initializeToken()
        const result = await reloadRemotePlugins(configuration.cliApiToken, pluginId)
        if (json) {
            console.log(JSON.stringify(result, null, 2))
        } else {
            const keptPrevious = result.results.some((item) => item.action === 'kept-previous')
            if (result.ok && !keptPrevious) {
                console.log(chalk.green('Plugin state saved and Hub reload applied.'))
            } else {
                console.log(chalk.yellow('Plugin state saved, reload failed or kept previous active instance.'))
            }
            for (const item of result.results) {
                console.log(`${item.id}: ${item.action} (${item.status})${item.message ? ` - ${item.message}` : ''}`)
            }
        }
    } catch (error) {
        console.log(chalk.yellow(`${stateSavedMessage} Hub reload was not applied: ${error instanceof Error ? error.message : String(error)}`))
        console.log(chalk.gray('Run hapi plugins reload or restart hapi hub to apply.'))
    }
}

async function reloadRemoteOptional(pluginId: string | undefined, requested: boolean): Promise<PluginReloadResult | undefined> {
    if (!requested) {
        return undefined
    }
    await initializeApiUrl()
    await initializeToken()
    return await reloadRemotePlugins(configuration.cliApiToken, pluginId)
}

async function ensurePluginAdminToken(): Promise<void> {
    await initializeApiUrl()
    await initializeToken()
}

async function enableInstalledPlugin(record: DiscoveredPluginRecord, config?: Record<string, unknown>): Promise<void> {
    if (!record.manifest) {
        throw new Error('Cannot enable plugin without a valid manifest.')
    }
    assertPluginConfigSafeForPersistence(config, record.manifest.permissions?.secrets ?? [], record.manifest.id)
    const state = await readWritableState()
    const previous = state.enabled[record.manifest.id]
    state.enabled[record.manifest.id] = {
        ...previous,
        enabled: true,
        ...(config ? { config, configUpdatedAt: Date.now() } : previous?.config ? { config: previous.config } : {})
    }
    await writePluginState(getPluginStateFile(configuration.happyHomeDir), state)
}

async function buildLocalInstallResult(args: {
    action: PluginInstallAction
    pluginId: string
    sourcePath?: string
    targetPath: string
    record: DiscoveredPluginRecord
    reload?: PluginReloadResult
}): Promise<PluginInstallResult> {
    const plugins = (await loadLocalRecords()).records.map(toLocalListItem)
    const plugin = plugins.find((entry) => entry.id === args.pluginId)
    return {
        ok: args.reload?.ok ?? true,
        action: args.action,
        ...(plugin ? { plugin } : {}),
        pluginId: args.pluginId,
        ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
        targetPath: args.targetPath,
        diagnostics: args.record.diagnostics.map((diagnostic) => ({ ...diagnostic, pluginId: args.pluginId })),
        ...(args.reload ? { reload: args.reload } : {}),
        plugins
    }
}

async function runList(args: string[]): Promise<void> {
    const json = hasFlag(args, '--json')
    const target = parseTargetArg(args)
    const remote = await tryRemoteList(target)
    const payload = remote ?? { plugins: (await loadLocalRecords()).records.map(toLocalListItem) }
    if (json) {
        console.log(JSON.stringify(payload, null, 2))
    } else {
        printTable(payload.plugins)
        if (!remote) {
            console.log(chalk.gray('\nActive state is shown as no when Hub plugin API is offline or unavailable.'))
        }
    }
}

async function runInspect(args: string[]): Promise<void> {
    const id = args[0]
    if (!id) throw new Error('Usage: hapi plugins inspect <id> [--json]')
    const json = hasFlag(args, '--json')
    const { records } = await loadLocalRecords()
    const record = findRecord(records, id)
    if (!record) throw new Error(`Plugin not found: ${id}`)
    const item = toLocalListItem(record)
    const detail = {
        ...item,
        manifest: record.manifest,
        config: sanitizePluginConfigForView(record.config, record.manifest?.permissions?.secrets ?? []),
        runtimeEntryPaths: record.runtimeEntryPaths,
        contributions: {
            notificationChannels: record.manifest?.contributions?.hub?.notificationChannels ?? [],
            ...(record.manifest?.contributions?.runner ? { runner: record.manifest.contributions.runner } : {}),
            ...(record.manifest?.contributions?.agent ? { agent: record.manifest.contributions.agent } : {}),
            ...(record.manifest?.contributions?.voice ? { voice: record.manifest.contributions.voice } : {}),
            ...(record.manifest?.contributions?.deployment ? { deployment: record.manifest.contributions.deployment } : {}),
            ...(record.manifest?.contributions?.integration ? { integration: record.manifest.contributions.integration } : {}),
            ...(record.manifest?.contributions?.web ? { web: record.manifest.contributions.web } : {})
        },
        permissions: {
            network: record.manifest?.permissions?.network ?? [],
            secrets: (record.manifest?.permissions?.secrets ?? []).map((name) => ({ name, present: Boolean(process.env[name]) }))
        }
    }
    if (json) {
        console.log(JSON.stringify({ plugin: detail }, null, 2))
        return
    }
    console.log(chalk.bold(`${record.manifest?.name ?? pluginId(record)} (${pluginId(record)})`))
    console.log(`Status: ${item.status}`)
    console.log(`Enabled: ${item.enabled ? 'yes' : 'no'}`)
    console.log(`Source: ${item.source}`)
    console.log(`Root: ${item.rootPath}`)
    console.log(`Manifest: ${item.manifestPath}`)
    console.log(`Hub entry: ${record.manifest?.runtimes?.hub?.entry ?? '(none)'}`)
    console.log(`Runner entry: ${record.manifest?.runtimes?.runner?.entry ?? '(none)'}`)
    const runnerContributions = record.manifest?.contributions?.runner
    const extensionLabels = [
        ...(runnerContributions?.environmentProviders ?? []).map((entry) => `env:${entry.id}`),
        ...(runnerContributions?.commandResolvers ?? []).map((entry) => `command:${entry.id}`),
        ...(runnerContributions?.spawnHooks ?? []).map((entry) => `spawn:${entry.id}`)
    ]
    console.log(`Runner extensions: ${extensionLabels.join(', ') || '(none)'}`)
    console.log(`Network: ${(record.manifest?.permissions?.network ?? []).join(', ') || '(none)'}`)
    console.log(`Secrets: ${(record.manifest?.permissions?.secrets ?? []).join(', ') || '(none)'}`)
    if (record.config) {
        console.log(`Config: ${JSON.stringify(sanitizePluginConfigForView(record.config, record.manifest?.permissions?.secrets ?? []), null, 2)}`)
    }
    printDiagnostics(record.diagnostics)
}

async function runEnable(args: string[]): Promise<void> {
    const id = args[0]
    if (!id) throw new Error('Usage: hapi plugins enable <id> [--config <json-or-@file>] [--reload] [--yes]')
    const json = hasFlag(args, '--json')
    const { records } = await loadLocalRecords()
    const record = findRecord(records, id)
    if (!record) throw new Error(`Plugin not found or invalid: ${id}`)
    assertLocalRecordCanBeEnabled(record, id)
    await confirmRisk(record, 'enable', hasFlag(args, '--yes') || hasFlag(args, '-y'))
    const config = await parseConfigArg(valueAfter(args, '--config'))
    assertPluginConfigSafeForPersistence(config, record.manifest.permissions?.secrets ?? [], record.manifest.id)
    const writableState = await readWritableState()
    const previous = writableState.enabled[record.manifest.id]
    writableState.enabled[record.manifest.id] = {
        ...previous,
        enabled: true,
        ...(config ? { config, configUpdatedAt: Date.now() } : previous?.config ? { config: previous.config } : {})
    }
    await writePluginState(getPluginStateFile(configuration.happyHomeDir), writableState)
    await maybeReload(record.manifest.id, hasFlag(args, '--reload'), json, 'Plugin enabled locally.')
}

async function runDisable(args: string[]): Promise<void> {
    const id = args[0]
    if (!id) throw new Error('Usage: hapi plugins disable <id> [--reload] [--yes]')
    const json = hasFlag(args, '--json')
    const { records } = await loadLocalRecords()
    const record = findRecord(records, id)
    if (!record?.manifest) throw new Error(`Plugin not found or invalid: ${id}`)
    await confirmRisk(record, 'disable', hasFlag(args, '--yes') || hasFlag(args, '-y'))
    const state = await readWritableState()
    const previous = state.enabled[record.manifest.id]
    state.enabled[record.manifest.id] = {
        ...previous,
        enabled: false
    }
    await writePluginState(getPluginStateFile(configuration.happyHomeDir), state)
    await maybeReload(record.manifest.id, hasFlag(args, '--reload'), json, 'Plugin disabled locally.')
}

async function runConfig(args: string[]): Promise<void> {
    const target = parseTargetArg(args)
    const positional = positionalArgs(args, ['--target'])
    const sub = positional[0]
    const id = positional[1]
    if (!sub || !id || !['get', 'set'].includes(sub)) {
        throw new Error('Usage: hapi plugins config get <id> [--target hub|runner:<machineId>] [--json] | hapi plugins config set <id> <key> <value> [--target hub|runner:<machineId>] [--reload] [--json]')
    }
    if (target) {
        if (target === 'all-runners') {
            throw new Error('Plugin config get/set requires target=hub or target=runner:<machineId>; all-runners is not supported for config.')
        }
        await ensurePluginAdminToken()
        const detail = await getRemotePlugin(configuration.cliApiToken, id, 5000, target)
        if (sub === 'get') {
            const payload = {
                id: detail.plugin.id,
                target: detail.plugin.target,
                configScope: detail.plugin.configMetadata?.scope ?? detail.plugin.configScope,
                config: detail.plugin.configMetadata?.config ?? detail.plugin.config ?? {}
            }
            console.log(hasFlag(args, '--json') ? JSON.stringify(payload, null, 2) : JSON.stringify(payload.config, null, 2))
            return
        }
        const key = positional[2]
        const value = positional[3]
        if (!key || value === undefined) {
            throw new Error('Usage: hapi plugins config set <id> <key> <value> [--target hub|runner:<machineId>] [--reload] [--json]')
        }
        const nextConfig = { ...(detail.plugin.configMetadata?.config ?? detail.plugin.config ?? {}), [key]: parseValue(value) }
        const result = await updateRemotePluginConfig(configuration.cliApiToken, id, { config: nextConfig }, 5000, target)
        if (hasFlag(args, '--json')) {
            console.log(JSON.stringify(result, null, 2))
            return
        }
        console.log(chalk.green(`Plugin config saved for ${target}.`))
        for (const item of result.results) {
            console.log(`${item.id}: ${item.action} (${item.status})${item.message ? ` - ${item.message}` : ''}`)
        }
        return
    }
    const { records } = await loadLocalRecords()
    const record = findRecord(records, id)
    if (!record) throw new Error(`Plugin not found or invalid: ${id}`)
    assertLocalRecordCanBeEnabled(record, id)
    const state = await readWritableState()
    const entry = state.enabled[record.manifest.id] ?? { enabled: record.enabled === true }
    if (sub === 'get') {
        const payload = { id: record.manifest.id, config: sanitizePluginConfigForView(entry.config, record.manifest.permissions?.secrets ?? []) ?? {} }
        console.log(hasFlag(args, '--json') ? JSON.stringify(payload, null, 2) : JSON.stringify(payload.config, null, 2))
        return
    }
    const key = positional[2]
    const value = positional[3]
    if (!key || value === undefined) {
        throw new Error('Usage: hapi plugins config set <id> <key> <value> [--reload]')
    }
    const nextConfig = { ...(entry.config ?? {}), [key]: parseValue(value) }
    assertPluginConfigSafeForPersistence(nextConfig, record.manifest.permissions?.secrets ?? [], record.manifest.id)
    state.enabled[record.manifest.id] = {
        ...entry,
        enabled: entry.enabled,
        config: nextConfig,
        configUpdatedAt: Date.now()
    }
    await writePluginState(getPluginStateFile(configuration.happyHomeDir), state)
    await maybeReload(record.manifest.id, hasFlag(args, '--reload'), hasFlag(args, '--json'), 'Plugin config saved locally.')
}

async function runInstallLocal(args: string[]): Promise<void> {
    const sourcePath = positionalArgs(args, ['--target'])[0]
    const target = parseTargetArg(args)
    if (!sourcePath || !target) throw new Error('Usage: hapi plugins install-local <path> --target hub|runner:<machineId>|all-runners [--enable] [--reload] [--overwrite] [--json]')
    await initializeApiUrl()
    await initializeToken()
    const payload = await installRemoteLocalPlugin(configuration.cliApiToken, {
        sourcePath,
        enable: hasFlag(args, '--enable'),
        reload: hasFlag(args, '--reload'),
        overwrite: hasFlag(args, '--overwrite')
    }, 120000, target)
    if (hasFlag(args, '--json')) {
        console.log(JSON.stringify(payload, null, 2))
        return
    }
    console.log(chalk.green(`Plugin install ${payload.ok ? 'completed' : 'completed with issues'} on ${target}.`))
    for (const targetResult of payload.targetResults ?? []) {
        console.log(`${targetResult.target.scope}: ${targetResult.ok ? 'ok' : 'failed'}${targetResult.error ? ` - ${targetResult.error}` : ''}`)
    }
    if (!payload.targetResults) {
        console.log(chalk.gray(`Plugin: ${payload.pluginId ?? '(unknown)'}`))
        console.log(chalk.gray(`Target path: ${payload.targetPath ?? '(multiple)'}`))
    }
}

async function runInstallPackage(args: string[]): Promise<void> {
    const packagePath = positionalArgs(args, ['--target', '--runners'])[0]
    const legacyTarget = parseTargetArg(args)
    if (legacyTarget) {
        throw new Error('Plugin package install no longer accepts --target. Installation targets are inferred from the plugin manifest; use --runners compatible|all|id[,id] only when narrowing Runner placement.')
    }
    if (!packagePath) throw new Error('Usage: hapi plugins install-package <package.tgz|package.zip> [--runners compatible|all|id[,id]] [--dry-run] [--enable] [--reload] [--overwrite] [--json]')
    const bytes = await readFile(packagePath)
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const lowered = packagePath.toLowerCase()
    const format = lowered.endsWith('.zip') ? 'zip' : lowered.endsWith('.tgz') || lowered.endsWith('.tar.gz') ? 'tgz' : undefined
    if (!format) throw new Error('Plugin package must be .tgz, .tar.gz, or .zip.')
    await initializeApiUrl()
    await initializeToken()
    const plan = await createRemotePluginInstallPlan(configuration.cliApiToken, {
        filename: basename(packagePath),
        contentBase64: bytes.toString('base64'),
        checksum,
        format,
        enable: hasFlag(args, '--enable'),
        reload: hasFlag(args, '--reload'),
        overwrite: hasFlag(args, '--overwrite'),
        runnerSelection: parseRunnerSelectionArg(args),
        dryRun: hasFlag(args, '--dry-run')
    }, 120000)
    if (hasFlag(args, '--dry-run')) {
        if (hasFlag(args, '--json')) {
            console.log(JSON.stringify(plan, null, 2))
            return
        }
        printInstallPlan(plan)
        return
    }
    if (plan.blockingErrors.length > 0) {
        if (hasFlag(args, '--json')) {
            console.log(JSON.stringify(plan, null, 2))
            return
        }
        printInstallPlan(plan)
        throw new Error('Plugin install plan is blocked.')
    }
    const payload = await executeRemotePluginInstallPlan(configuration.cliApiToken, plan.planId, 120000)
    if (hasFlag(args, '--json')) {
        console.log(JSON.stringify({ plan, result: payload }, null, 2))
        return
    }
    printInstallPlan(plan)
    console.log(chalk.green(`Plugin package install ${payload.ok ? 'completed' : 'completed with issues'}.`))
    for (const targetResult of payload.targetResults ?? []) {
        console.log(`${targetResult.target.scope}: ${targetResult.ok ? 'ok' : 'failed'}${targetResult.error ? ` - ${targetResult.error}` : ''}`)
    }
    if (!payload.targetResults) {
        console.log(chalk.gray(`Plugin: ${payload.pluginId ?? '(unknown)'}`))
        console.log(chalk.gray(`Target path: ${payload.targetPath ?? '(multiple)'}`))
    }
}

async function runMarketplace(args: string[]): Promise<void> {
    const action = args[0] ?? 'list'
    const rest = args.slice(1)
    const json = hasFlag(args, '--json')
    if (action === 'list' || action === 'search') {
        const query = valueAfter(rest, '--q') ?? positionalArgs(rest, ['--q', '--category', '--runtime'])[0]
        await ensurePluginAdminToken()
        const payload = await getRemotePluginMarketplace(configuration.cliApiToken, 5000, {
            q: query,
            category: valueAfter(rest, '--category'),
            runtime: valueAfter(rest, '--runtime')
        })
        if (json) {
            console.log(JSON.stringify(payload, null, 2))
            return
        }
        console.log(chalk.gray(`Marketplace: ${payload.sourceUrl}`))
        printMarketplaceTable(payload.entries)
        return
    }

    if (action === 'refresh' || action === 'check-updates') {
        await ensurePluginAdminToken()
        const payload = await refreshRemotePluginMarketplace(configuration.cliApiToken, 120000)
        if (json) {
            console.log(JSON.stringify(payload, null, 2))
            return
        }
        const updateCount = payload.entries.filter((entry) => entry.installed?.updateAvailable).length
        const yankedCount = payload.entries.filter((entry) => entry.installed?.yanked).length
        console.log(chalk.gray(`Marketplace: ${payload.sourceUrl}`))
        console.log(chalk.gray(`Checked: ${new Date(payload.fetchedAt).toLocaleString()}`))
        console.log(updateCount > 0 ? chalk.yellow(`${updateCount} plugin update(s) available.`) : chalk.green('All installed marketplace plugins are up to date.'))
        if (yankedCount > 0) {
            console.log(chalk.red(`${yankedCount} installed plugin release(s) were yanked.`))
        }
        printMarketplaceTable(payload.entries)
        return
    }

    if (action === 'info' || action === 'inspect') {
        const id = positionalArgs(rest)[0]
        if (!id) throw new Error('Usage: hapi plugins marketplace info <id> [--json]')
        await ensurePluginAdminToken()
        const payload = await getRemotePluginMarketplaceEntry(configuration.cliApiToken, id, 5000)
        if (json) {
            console.log(JSON.stringify(payload, null, 2))
            return
        }
        const latest = latestMarketplaceRelease(payload.entry)
        console.log(chalk.bold(`${payload.entry.name} (${payload.entry.id})`))
        console.log(`Repo: ${payload.entry.repo}`)
        console.log(`Latest: ${latest?.version ?? '(none)'}`)
        console.log(`Source: ${latest?.source?.path ?? latest?.package?.url ?? '(none)'}`)
        console.log(`Checksum: ${latest?.source?.treeChecksum ?? latest?.package?.checksum ?? '(none)'}`)
        console.log(`Categories: ${(payload.entry.categories ?? []).join(', ') || '(none)'}`)
        console.log(`Description: ${payload.entry.description ?? '(none)'}`)
        console.log(chalk.gray(`Marketplace: ${payload.sourceUrl}`))
        return
    }

    if (action === 'install' || action === 'update') {
        const id = positionalArgs(rest, ['--version', '--runners'])[0]
        if (!id) throw new Error('Usage: hapi plugins marketplace install|update <id> [--version x.y.z] [--runners compatible|all|id[,id]] [--dry-run] [--enable] [--reload] [--overwrite] [--json]')
        await ensurePluginAdminToken()
        const overwrite = action === 'update' || hasFlag(rest, '--overwrite')
        const planPayload: PluginMarketplaceInstallPlanResponse = await createRemoteMarketplaceInstallPlan(configuration.cliApiToken, id, {
            version: valueAfter(rest, '--version'),
            enable: hasFlag(rest, '--enable'),
            reload: hasFlag(rest, '--reload'),
            overwrite,
            runnerSelection: parseRunnerSelectionArg(rest)
        }, 120000)
        if (hasFlag(rest, '--dry-run')) {
            if (json) {
                console.log(JSON.stringify(planPayload, null, 2))
                return
            }
            console.log(chalk.gray(`Marketplace source: ${planPayload.marketplace.assetUrl ?? planPayload.marketplace.sourcePath ?? planPayload.marketplace.distribution}`))
            printInstallPlan(planPayload.plan)
            return
        }
        if (planPayload.plan.blockingErrors.length > 0) {
            if (json) {
                console.log(JSON.stringify(planPayload, null, 2))
                return
            }
            printInstallPlan(planPayload.plan)
            throw new Error('Marketplace plugin install plan is blocked.')
        }
        const result = await executeRemotePluginInstallPlan(configuration.cliApiToken, planPayload.plan.planId, 120000)
        if (json) {
            console.log(JSON.stringify({ ...planPayload, result }, null, 2))
            return
        }
        console.log(chalk.gray(`Marketplace source: ${planPayload.marketplace.assetUrl ?? planPayload.marketplace.sourcePath ?? planPayload.marketplace.distribution}`))
        printInstallPlan(planPayload.plan)
        console.log(chalk.green(`Marketplace plugin ${action === 'update' ? 'update' : 'install'} ${result.ok ? 'completed' : 'completed with issues'}.`))
        for (const targetResult of result.targetResults ?? []) {
            console.log(`${targetResult.target.scope}: ${targetResult.ok ? 'ok' : 'failed'}${targetResult.error ? ` - ${targetResult.error}` : ''}`)
        }
        return
    }

    throw new Error(`Unknown plugins marketplace subcommand: ${action}`)
}

async function runDelete(args: string[]): Promise<void> {
    const id = args.find((arg) => !arg.startsWith('-'))
    if (!id) throw new Error('Usage: hapi plugins delete <id> [--reload] [--json] [--yes]')
    const json = hasFlag(args, '--json')
    const { records } = await loadLocalRecords()
    const record = findRecord(records, id)
    if (!record) throw new Error(`Plugin not found: ${id}`)
    if (record.source !== 'user-home') {
        throw new Error(`Plugin ${id} cannot be deleted because it is from ${record.source}. Only user-home plugins can be deleted.`)
    }
    await confirmDelete(record, hasFlag(args, '--yes') || hasFlag(args, '-y'))

    const pluginIdValue = record.manifest?.id ?? pluginId(record)
    const [userPluginsRealPath, rootRealPath] = await Promise.all([
        realpath(getUserPluginsDir(configuration.happyHomeDir)),
        realpath(record.rootPath)
    ])
    if (!isPathInside(userPluginsRealPath, rootRealPath)) {
        throw new Error(`Plugin ${pluginIdValue} cannot be deleted because its path is outside the user plugin directory.`)
    }

    const state = await readWritableState()
    if (record.manifest) {
        delete state.enabled[record.manifest.id]
    }
    await writePluginState(getPluginStateFile(configuration.happyHomeDir), state)
    await rm(rootRealPath, { recursive: true, force: true })

    let reloadResult: PluginReloadResult | undefined
    try {
        reloadResult = await reloadRemoteOptional(pluginIdValue, hasFlag(args, '--reload'))
    } catch (error) {
        if (!json) {
            console.log(chalk.yellow(`Plugin deleted locally, but Hub reload was not applied: ${error instanceof Error ? error.message : String(error)}`))
            console.log(chalk.gray('Run hapi plugins reload or restart hapi hub to apply.'))
        }
    }

    const plugins = (await loadLocalRecords()).records.map(toLocalListItem)
    const payload: PluginDeleteResult = {
        ok: reloadResult?.ok ?? true,
        pluginId: pluginIdValue,
        rootPath: rootRealPath,
        deleted: true,
        ...(reloadResult ? { reload: reloadResult } : {}),
        plugins
    }
    if (json) {
        console.log(JSON.stringify(payload, null, 2))
        return
    }

    console.log(chalk.green(`Plugin deleted: ${pluginIdValue}`))
    console.log(chalk.gray(`Removed: ${rootRealPath}`))
    if (!hasFlag(args, '--reload')) {
        console.log(chalk.gray('Run hapi plugins reload or restart hapi hub to apply.'))
    } else if (reloadResult) {
        console.log(chalk.green(reloadResult.ok ? 'Hub reload applied.' : 'Hub reload completed with issues.'))
    }
}

async function runReload(args: string[]): Promise<void> {
    const id = positionalArgs(args, ['--target'])[0]
    await initializeApiUrl()
    await initializeToken()
    const result: PluginReloadResult = await reloadRemotePlugins(configuration.cliApiToken, id, 5000, parseTargetArg(args))
    if (hasFlag(args, '--json')) {
        console.log(JSON.stringify(result, null, 2))
        return
    }
    for (const item of result.results) {
        const color = item.action === 'failed' || item.action === 'kept-previous' ? chalk.yellow : chalk.green
        console.log(color(`${item.id}: ${item.action} (${item.status})${item.message ? ` - ${item.message}` : ''}`))
    }
}

async function runDoctor(args: string[]): Promise<void> {
    const targetId = args.find((arg) => !arg.startsWith('-'))
    const json = hasFlag(args, '--json')
    const { records, parseError } = await loadLocalRecords()
    const diagnostics: Array<PluginDiagnostic & { pluginId?: string }> = []
    if (parseError) {
        diagnostics.push({ severity: 'error', code: 'plugin-state-parse-error', message: parseError })
    }
    for (const record of records) {
        const id = pluginId(record)
        if (targetId && id !== targetId && record.manifest?.id !== targetId) continue
        diagnostics.push(...record.diagnostics.map((diagnostic) => ({ ...diagnostic, pluginId: id })))
        for (const secret of record.manifest?.permissions?.secrets ?? []) {
            if (!process.env[secret]) {
                diagnostics.push({ pluginId: id, severity: 'warning', code: 'missing-secret', message: `Declared secret ${secret} is not set.` })
            }
        }
        const schemaPath = record.manifest?.config?.schema
        if (schemaPath) {
            const resolved = resolve(record.rootPath, schemaPath)
            if (!existsSync(resolved)) {
                diagnostics.push({ pluginId: id, severity: 'error', code: 'missing-config-schema', message: `Config schema ${schemaPath} is missing.`, path: resolved })
            }
        }
    }
    if (json) {
        console.log(JSON.stringify({ diagnostics }, null, 2))
        return
    }
    printDiagnostics(diagnostics)
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi plugins')} - Local plugin management

${chalk.bold('Usage:')}
  hapi plugins list [--target hub|runner:<machineId>|all-runners] [--json]
  hapi plugins inspect <id> [--json]
  hapi plugins enable <id> [--config <json-or-@file>] [--reload] [--yes]
  hapi plugins disable <id> [--reload] [--yes]
  hapi plugins config get <id> [--target hub|runner:<machineId>] [--json]
  hapi plugins config set <id> <key> <value> [--target hub|runner:<machineId>] [--reload] [--json]
  hapi plugins install-local <path> --target hub|runner:<machineId>|all-runners [--enable] [--reload] [--overwrite] [--json]
  hapi plugins install-package <package.tgz|package.zip> [--runners compatible|all|id[,id]] [--dry-run] [--enable] [--reload] [--overwrite] [--json]
  hapi plugins marketplace list [query] [--category <category>] [--runtime hub|runner] [--json]
  hapi plugins marketplace refresh [--json]
  hapi plugins marketplace info <id> [--json]
  hapi plugins marketplace install <id> [--version x.y.z] [--runners compatible|all|id[,id]] [--dry-run] [--enable] [--reload] [--overwrite] [--json]
  hapi plugins marketplace update <id> [--version x.y.z] [--runners compatible|all|id[,id]] [--dry-run] [--enable] [--reload] [--json]
  hapi plugins delete <id> [--reload] [--json] [--yes]
  hapi plugins reload [id] [--json]
  hapi plugins doctor [id] [--json]

Package archives must include hapi.plugin.package.json metadata. Hub reads the manifest, plans required Hub/Web/Runner positions, validates host compatibility, then distributes uploads to compatible Runner targets.
`)
}

export async function handlePluginsCommand(args: string[]): Promise<void> {
    const subcommand = args[0]
    const rest = args.slice(1)
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showHelp()
        return
    }
    if (subcommand === 'list') return await runList(rest)
    if (subcommand === 'inspect') return await runInspect(rest)
    if (subcommand === 'enable') return await runEnable(rest)
    if (subcommand === 'disable') return await runDisable(rest)
    if (subcommand === 'config') return await runConfig(rest)
    if (subcommand === 'marketplace' || subcommand === 'market') return await runMarketplace(rest)
    if (subcommand === 'search') return await runMarketplace(['list', ...rest])
    if (subcommand === 'install-local' || subcommand === 'install') return await runInstallLocal(rest)
    if (subcommand === 'install-package' || subcommand === 'install-upload') return await runInstallPackage(rest)
    if (subcommand === 'delete' || subcommand === 'remove' || subcommand === 'uninstall') return await runDelete(rest)
    if (subcommand === 'reload') return await runReload(rest)
    if (subcommand === 'doctor') return await runDoctor(rest)
    throw new Error(`Unknown plugins subcommand: ${subcommand}`)
}

export const pluginsCommand: CommandDefinition = {
    name: 'plugins',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handlePluginsCommand(commandArgs)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
