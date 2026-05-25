import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import type {
    HubMessageActionInput,
    HubMessageActionResult,
    PluginCapabilityPart,
    PluginCapabilityPartStatus,
    PluginCapabilityView,
    PluginDeleteResult,
    PluginDetail,
    PluginDiagnosticView,
    PluginInstallAction,
    PluginInstallLocalRequest,
    PluginInstallResult,
    PluginInstallPackageRequest,
    PluginListItem,
    PluginLocalDirectoryListResponse,
    PluginNotificationEvent,
    PluginNotificationTestResponse,
    PluginReloadItem,
    PluginReloadResult,
    PluginRuntimeContributionState,
    PluginHostInfo,
    PluginTargetSummary,
    PluginWebContributionView
} from '@hapi/protocol/plugins'
import {
    applyPluginState,
    discoverPlugins,
    getPluginStateFile,
    readPluginState,
    type DiscoveredPluginRecord
} from '@hapi/protocol/plugins/foundation'
import { HAPI_PLUGIN_API_VERSION, HAPI_SUPPORTED_PLUGIN_API_VERSIONS, hubPluginConfigScope, pluginManifestRequiresHubInstall, sanitizePluginConfigForView } from '@hapi/protocol/plugins'
import { seedDefaultFirstPartyPluginsAsUserPlugins } from '@hapi/protocol/plugins/bundledCore'
import { prepareBundledExamplePlugins } from '@hapi/protocol/plugins/bundledExamples'
import { HUB_IMPLEMENTED_EXTENSION_POINTS } from '@hapi/protocol/plugins/extensionPoints'
import { activateRuntimeRecord, safeMtime, stableStringify } from '@hapi/protocol/plugins/runtime/activation'
import { diagnosticView, errorMessage, reloadItemIsOk } from '@hapi/protocol/plugins/runtime/diagnostics'
import { applyRuntimeCompatibility } from '@hapi/protocol/plugins/runtime/compatibility'
import { redactText } from '@hapi/protocol/plugins/runtime/registryBase'
import {
    aggregateCapabilityStatus,
    webContributionsForPart,
    webPartStatus as runtimeWebPartStatus
} from '@hapi/protocol/plugins/runtime/capabilityView'
import { performRuntimeReload } from '@hapi/protocol/plugins/runtime/reloadController'
import { PluginRuntimeStateController } from '@hapi/protocol/plugins/runtime/stateController'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import { HubPluginRegistry, type RegisteredHubMessageAction } from './registry'
import packageJson from '../../../cli/package.json'

export interface HubPluginManagerOptions {
    hapiHome: string
    publicUrl?: string
    envPluginDirs?: string
    env?: NodeJS.ProcessEnv
    watch?: boolean
    watchDebounceMs?: number
    includeBundledCore?: boolean
    includeBundledExamples?: boolean
    activationTimeoutMs?: number
}

type ActivePluginInstance = {
    pluginId: string
    registry: HubPluginRegistry
    record: DiscoveredPluginRecord
    signature: string
    loadedAt: number
}

type ReloadReason = 'startup' | 'manual' | 'state-change' | 'watch'

type InternalReloadResult = {
    records: DiscoveredPluginRecord[]
    items: PluginReloadItem[]
}

function pluginDisplayId(record: DiscoveredPluginRecord): string {
    const id = record.manifest?.id ?? basename(record.rootPath)
    if (record.manifest && record.status !== 'blocked') {
        return id
    }
    const hash = createHash('sha256').update(record.rootPath).digest('hex').slice(0, 8)
    return `${id}#${hash}`
}

function buildPluginSettingsUrl(publicUrl: string | undefined, pluginId: string): string | undefined {
    const path = `/settings/plugins/${encodeURIComponent(pluginId)}`
    if (!publicUrl) {
        return path
    }
    try {
        return new URL(path, publicUrl).toString()
    } catch {
        return `${publicUrl.replace(/\/+$/, '')}${path}`
    }
}

function isHubMessageActionResult(value: unknown): value is HubMessageActionResult {
    if (!value || typeof value !== 'object') {
        return false
    }
    const record = value as Record<string, unknown>
    if (record.ok === false) {
        return typeof record.code === 'string' && record.code.length > 0
            && typeof record.message === 'string' && record.message.length > 0
    }
    return record.ok === true && 'plan' in record
}

export class HubPluginManager {
    private readonly activePlugins = new Map<string, ActivePluginInstance>()
    private readonly stateController: PluginRuntimeStateController
    private records: DiscoveredPluginRecord[] = []
    private managerDiagnostics: PluginDiagnosticView[] = []
    private reloadQueue: Promise<InternalReloadResult> = Promise.resolve({ records: [], items: [] })
    private watchers: FSWatcher[] = []
    private watchTimer: NodeJS.Timeout | null = null
    private disposed = false
    private readonly notificationChannel: NotificationChannel

    constructor(private readonly options: HubPluginManagerOptions) {
        this.stateController = new PluginRuntimeStateController({
            hapiHome: options.hapiHome,
            configScope: (pluginId) => hubPluginConfigScope(pluginId),
            defaultEnabledPluginIds: () => this.defaultEnabledPluginIds(),
            enableDefaultOnConfigUpdate: true,
            displayId: pluginDisplayId
        })
        this.notificationChannel = this.createNotificationMultiplexer()
    }

    async start(): Promise<PluginReloadResult> {
        const result = await this.reload(undefined, 'startup')
        if (this.options.watch !== false) {
            this.resetWatchers()
        }
        return result
    }

    getNotificationChannel(): NotificationChannel {
        return this.notificationChannel
    }

    listPlugins(): PluginListItem[] {
        return this.records.map((record) => this.toListItem(record))
    }

    getPlugin(id: string): PluginDetail | null {
        const record = this.records.find((entry) => pluginDisplayId(entry) === id || entry.manifest?.id === id)
        return record ? this.toDetail(record) : null
    }

    collectWebContributions(): PluginWebContributionView[] {
        return this.records
            .filter((record) => record.enabled === true && record.manifest?.contributions?.web)
            .map((record) => ({
                pluginId: record.manifest!.id,
                pluginName: record.manifest!.name,
                target: this.targetSummary().scope,
                contributions: record.manifest!.contributions!.web!
            }))
    }

    collectContributionStates(): PluginRuntimeContributionState[] {
        const target = this.targetSummary()
        return this.records
            .filter((record) => record.manifest)
            .flatMap((record) => {
                const pluginId = record.manifest!.id
                const registry = this.activePlugins.get(pluginId)?.registry
                const registeredMessageActionIds = new Set((registry?.getMessageActions() ?? []).map((entry) => entry.id))
                const enabled = record.enabled === true
                const active = this.activePlugins.has(pluginId)
                const diagnostics = [
                    ...record.diagnostics.map((entry) => diagnosticView(pluginId, entry)),
                    ...(registry?.diagnostics.map((entry) => diagnosticView(pluginId, entry)) ?? [])
                ]

                const notificationStates = (record.manifest!.contributions?.hub?.notificationChannels ?? []).map((channel) => ({
                    pluginId,
                    target,
                    runtime: 'hub' as const,
                    contributionType: 'notificationChannel',
                    contributionId: channel.id,
                    declared: true,
                    registered: active,
                    active: enabled && active,
                    diagnostics
                }))
                const messageActionStates = (record.manifest!.contributions?.hub?.messageActions ?? []).map((action) => ({
                    pluginId,
                    target,
                    runtime: 'hub' as const,
                    contributionType: 'messageAction',
                    contributionId: action.id,
                    declared: true,
                    registered: registeredMessageActionIds.has(action.id),
                    active: enabled && registeredMessageActionIds.has(action.id),
                    diagnostics
                }))
                return [...notificationStates, ...messageActionStates]
            })
    }

    collectCapabilities(): PluginCapabilityView[] {
        const target = this.targetSummary()
        return this.records
            .filter((record) => record.manifest?.capabilities)
            .flatMap((record) => record.manifest!.capabilities!.map((capability): PluginCapabilityView => {
                const pluginId = record.manifest!.id
                const parts = {
                    ...(capability.parts.web ? { web: runtimeWebPartStatus(record, capability.parts.web) } : {}),
                    ...(capability.parts.hub ? { hub: this.hubPartStatus(record, capability.parts.hub) } : {}),
                    ...(capability.parts.runner ? {
                        runner: {
                            status: 'missing-target' as const,
                            required: capability.parts.runner.required,
                            declared: true,
                            registered: false,
                            active: false,
                            diagnostics: []
                        }
                    } : {})
                }
                return {
                    pluginId,
                    pluginName: record.manifest!.name,
                    pluginVersion: record.manifest!.version,
                    capabilityId: capability.id,
                    kind: capability.kind,
                    displayName: capability.displayName,
                    description: capability.description,
                    display: capability.display,
                    status: record.enabled === true ? aggregateCapabilityStatus(parts) : 'disabled',
                    target,
                    parts,
                    ...(capability.parts.web ? { web: webContributionsForPart(record, capability.parts.web) } : {}),
                    diagnostics: [
                        ...record.diagnostics.map((entry) => diagnosticView(pluginId, entry)),
                        ...(this.activePlugins.get(pluginId)?.registry.diagnostics.map((entry) => diagnosticView(pluginId, entry)) ?? [])
                    ]
                }
            }))
    }

    getHubMessageAction(pluginId: string, actionId: string): RegisteredHubMessageAction | null {
        const instance = this.activePlugins.get(pluginId)
        if (!instance) {
            return null
        }
        return instance.registry.getMessageActions().find((entry) => entry.id === actionId) ?? null
    }

    async planMessageAction(args: {
        pluginId: string
        actionId: string
        capabilityId?: string
        namespace: string
        session: HubMessageActionInput['session']
        text: string
        localId?: string
        attachments: HubMessageActionInput['attachments']
        payload: unknown
    }): Promise<HubMessageActionResult> {
        const action = this.getHubMessageAction(args.pluginId, args.actionId)
        if (!action) {
            return {
                ok: false,
                code: 'plugin-action-not-active',
                message: `Plugin message action ${args.pluginId}:${args.actionId} is not active.`
            }
        }
        try {
            const result = await action.contribution.plan({
                namespace: args.namespace,
                session: args.session,
                text: args.text,
                localId: args.localId,
                attachments: args.attachments,
                payload: args.payload,
                capabilityId: args.capabilityId,
                actionId: args.actionId
            })
            if (!isHubMessageActionResult(result)) {
                return {
                    ok: false,
                    code: 'plugin-action-invalid-result',
                    message: `Plugin message action ${args.pluginId}:${args.actionId} returned an invalid result.`
                }
            }
            if (!result.ok) {
                return {
                    ...result,
                    message: this.sanitizeRuntimeDiagnostic(args.pluginId, result.message)
                }
            }
            return result
        } catch (error) {
            return {
                ok: false,
                code: 'plugin-action-failed',
                message: `Plugin message action failed: ${this.sanitizeRuntimeDiagnostic(args.pluginId, error)}`
            }
        }
    }

    async testNotification(pluginId: string, namespace: string): Promise<PluginNotificationTestResponse> {
        const instance = this.activePlugins.get(pluginId)
        if (!instance) {
            const record = this.records.find((entry) => pluginDisplayId(entry) === pluginId || entry.manifest?.id === pluginId)
            if (!record) {
                throw new Error(`Plugin ${pluginId} was not found.`)
            }
            throw new Error(`Plugin ${pluginId} is not active.`)
        }

        const event: PluginNotificationEvent = {
            type: 'test',
            session: {
                id: `plugin-test-${Date.now()}`,
                namespace,
                name: 'Plugin notification test',
                path: 'HAPI settings',
                agent: 'HAPI',
                active: false,
                url: buildPluginSettingsUrl(this.options.publicUrl, pluginId)
            },
            task: {
                summary: 'This is a test notification from HAPI plugin settings.',
                status: 'test'
            }
        }

        const channels = await instance.registry.sendNotificationEvent(event)
        if (channels === 0) {
            throw new Error(`Plugin ${pluginId} does not have an active notification channel.`)
        }
        return {
            ok: true,
            pluginId,
            channels,
            message: `Sent test notification through ${channels} channel${channels === 1 ? '' : 's'}.`
        }
    }

    getDiagnostics(): PluginDiagnosticView[] {
        const recordDiagnostics = this.records.flatMap((record) => {
            const id = pluginDisplayId(record)
            return [
                ...record.diagnostics.map((entry) => diagnosticView(id, entry)),
                ...this.missingSecretDiagnostics(record)
            ]
        })
        const activeDiagnostics = Array.from(this.activePlugins.values()).flatMap((entry) =>
            entry.registry.diagnostics.map((diagnostic) => diagnosticView(entry.pluginId, diagnostic))
        )
        return [...this.managerDiagnostics, ...recordDiagnostics, ...activeDiagnostics]
    }

    async reload(targetId?: string, reason: ReloadReason = 'manual'): Promise<PluginReloadResult> {
        this.reloadQueue = this.reloadQueue
            .catch(() => ({ records: this.records, items: [] }))
            .then(() => this.performReload(targetId, reason))
        const internal = await this.reloadQueue
        return {
            ok: internal.items.every(reloadItemIsOk),
            ...(targetId ? { targetId } : {}),
            results: internal.items,
            plugins: this.listPlugins()
        }
    }

    async enablePlugin(id: string, config?: Record<string, unknown>, shouldReload = true): Promise<PluginReloadResult> {
        const pluginId = await this.stateController.enablePluginState(id, config, (candidate) => this.findDiscoveredRecord(candidate))
        return shouldReload ? await this.reload(pluginId, 'state-change') : this.currentNoopResult(pluginId)
    }

    async disablePlugin(id: string, shouldReload = true): Promise<PluginReloadResult> {
        const pluginId = await this.stateController.disablePluginState(id, (candidate) => this.findDiscoveredRecord(candidate))
        return shouldReload ? await this.reload(pluginId, 'state-change') : this.currentNoopResult(pluginId)
    }

    async updatePluginConfig(id: string, config: Record<string, unknown>, shouldReload = true): Promise<PluginReloadResult> {
        const pluginId = await this.stateController.updatePluginConfigState(id, config, (candidate) => this.findDiscoveredRecord(candidate))
        return shouldReload ? await this.reload(pluginId, 'state-change') : this.currentNoopResult(pluginId)
    }

    async installLocalPlugin(sourcePath: string, options: Omit<PluginInstallLocalRequest, 'sourcePath'> = {}): Promise<PluginInstallResult> {
        const install = await this.stateController.installLocalPlugin({ ...options, sourcePath }, 'hub-local-path')
        const pluginId = install.record.manifest!.id
        return await this.buildInstallResult({
            action: install.action,
            pluginId,
            sourcePath: install.sourcePath,
            targetPath: install.targetPath,
            diagnostics: install.record.diagnostics.map((entry) => diagnosticView(pluginId, entry)),
            reload: options.reload !== false,
            reloadReason: options.enable === true ? 'state-change' : 'manual'
        })
    }

    async installPluginPackage(options: PluginInstallPackageRequest): Promise<PluginInstallResult> {
        const install = await this.stateController.installPluginPackage(options)
        const pluginId = install.record.manifest!.id
        return await this.buildInstallResult({
            action: install.action,
            pluginId,
            sourcePath: options.filename,
            targetPath: install.targetPath,
            diagnostics: install.record.diagnostics.map((entry) => diagnosticView(pluginId, entry)),
            reload: options.reload !== false,
            reloadReason: options.enable === true ? 'state-change' : 'manual'
        })
    }

    async listLocalDirectory(path?: string): Promise<PluginLocalDirectoryListResponse> {
        return await this.stateController.listLocalDirectory(path)
    }

    async deletePlugin(id: string, shouldReload = true): Promise<PluginDeleteResult> {
        const deleted = await this.stateController.deleteUserHomePlugin(
            id,
            (candidate) => this.findDiscoveredRecord(candidate),
            (pluginId) => this.disposeActive(pluginId)
        )
        const reloadResult = shouldReload ? await this.reload(deleted.pluginId, 'state-change') : undefined
        return {
            ok: reloadResult?.ok ?? true,
            pluginId: deleted.pluginId,
            rootPath: deleted.rootPath,
            deleted: true,
            ...(reloadResult ? { reload: reloadResult } : {}),
            plugins: this.listPlugins()
        }
    }

    async dispose(): Promise<void> {
        this.disposed = true
        this.clearWatchers()
        if (this.watchTimer) {
            clearTimeout(this.watchTimer)
            this.watchTimer = null
        }
        const instances = Array.from(this.activePlugins.values()).reverse()
        this.activePlugins.clear()
        await Promise.all(instances.map(async (instance) => {
            try {
                await instance.registry.dispose()
            } catch (error) {
                console.error('[HubPluginManager] Plugin dispose failed:', error)
            }
        }))
    }

    private async buildInstallResult(options: {
        action: PluginInstallAction
        pluginId: string
        sourcePath?: string
        targetPath: string
        diagnostics?: PluginDiagnosticView[]
        reload: boolean
        reloadReason: ReloadReason
    }): Promise<PluginInstallResult> {
        let reloadResult: PluginReloadResult | undefined
        if (options.reload) {
            reloadResult = await this.reload(options.pluginId, options.reloadReason)
        }

        const plugin = this.listPlugins().find((entry) => entry.id === options.pluginId)
        return {
            ok: reloadResult?.ok ?? true,
            action: options.action,
            ...(plugin ? { plugin } : {}),
            pluginId: options.pluginId,
            ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
            targetPath: options.targetPath,
            diagnostics: options.diagnostics ?? plugin?.diagnostics ?? [],
            ...(reloadResult ? { reload: reloadResult } : {}),
            plugins: this.listPlugins()
        }
    }

    private createNotificationMultiplexer(): NotificationChannel {
        const each = async (call: (channel: NotificationChannel) => Promise<void>): Promise<void> => {
            const channels = Array.from(this.activePlugins.values())
                .flatMap((entry) => entry.registry.getNotificationChannels())
            for (const channel of channels) {
                try {
                    await call(channel)
                } catch (error) {
                    console.error('[HubPluginManager] Plugin notification failed:', error)
                }
            }
        }
        return {
            sendReady: async (session: Session) => each((channel) => channel.sendReady(session)),
            sendPermissionRequest: async (session: Session) => each((channel) => channel.sendPermissionRequest(session)),
            sendTaskNotification: async (session: Session, notification: TaskNotification) => each((channel) => channel.sendTaskNotification(session, notification)),
            sendSessionCompletion: async (session: Session, reason: SessionEndReason) => each(async (channel) => {
                if (typeof channel.sendSessionCompletion === 'function') {
                    await channel.sendSessionCompletion(session, reason)
                }
            })
        }
    }

    private async performReload(targetId: string | undefined, reason: ReloadReason): Promise<InternalReloadResult> {
        if (this.disposed) {
            return { records: this.records, items: [] }
        }

        const items: PluginReloadItem[] = []
        const managerDiagnostics: PluginDiagnosticView[] = []
        if (this.options.includeBundledCore === true) {
            await seedDefaultFirstPartyPluginsAsUserPlugins(this.options.hapiHome)
        }
        const stateResult = await readPluginState(getPluginStateFile(this.options.hapiHome))
        const discovered = await this.discoverPluginRecords()
        const records = this.stateController.applyScopedRuntimeConfig(applyPluginState(discovered, stateResult.state, {
            failClosed: stateResult.failClosed,
            defaultEnabledPluginIds: this.defaultEnabledPluginIds()
        }), stateResult.state)

        if (stateResult.parseError) {
            managerDiagnostics.push({
                severity: 'error',
                code: 'plugin-state-parse-error',
                message: `Failed to parse plugins.json; all plugins disabled: ${stateResult.parseError}`
            })
        }

        items.push(...await performRuntimeReload({
            records,
            activePlugins: this.activePlugins,
            targetId,
            runtime: 'hub',
            runtimeDisplayName: 'Hub',
            pluginDisplayId,
            computeSignature: (record) => this.computeSignature(record),
            activateRecord: (record, signature) => this.activateRecord(record, signature),
            disposeActive: (pluginId) => this.disposeActive(pluginId),
            disposeInstance: (instance) => instance.registry.dispose(),
            shouldDiscardActivatedInstance: () => this.disposed,
            discardedActivationMessage: 'Hub plugin manager disposed during activation.'
        }))

        this.records = records
        this.managerDiagnostics = managerDiagnostics
        if (reason === 'watch' || reason === 'manual' || reason === 'state-change') {
            this.resetWatchers()
        }
        return { records, items }
    }

    private async activateRecord(record: DiscoveredPluginRecord, signature: string) {
        const result = await activateRuntimeRecord({
            record,
            signature,
            runtime: 'hub',
            runtimeDisplayName: 'Hub',
            missingEntryCode: 'missing-hub-entry',
            invalidEntryCode: 'invalid-hub-entry',
            activationFailedCode: 'hub-plugin-activate-failed',
            activationFailureLabel: 'hub plugin',
            importQueryName: 'hapiPlugin',
            reloadMarker: 'hapi-reload',
            activationTimeoutMs: this.options.activationTimeoutMs,
            env: this.options.env,
            createRegistry: () => new HubPluginRegistry(this.options.publicUrl),
            createInstance: ({ pluginId, registry, record: activatedRecord, signature: activatedSignature, loadedAt }) => ({
                pluginId,
                registry,
                record: activatedRecord,
                signature: activatedSignature,
                loadedAt
            })
        })
        if (!result.ok) {
            return result
        }
        const diagnostics = this.validateHubRuntimeRegistrations(record, result.instance.registry)
        if (diagnostics.length > 0) {
            await result.instance.registry.dispose()
            return {
                ok: false as const,
                message: diagnostics.map((diagnostic) => diagnostic.message).join(' '),
                diagnostics
            }
        }
        return result
    }

    private validateHubRuntimeRegistrations(record: DiscoveredPluginRecord, registry: HubPluginRegistry): PluginDiagnosticView[] {
        const pluginId = record.manifest!.id
        const declaredMessageActionIds = new Set((record.manifest?.contributions?.hub?.messageActions ?? []).map((action) => action.id))
        const seenMessageActionIds = new Set<string>()
        const diagnostics: PluginDiagnosticView[] = []
        for (const action of registry.getMessageActions()) {
            if (!declaredMessageActionIds.has(action.id)) {
                diagnostics.push({
                    pluginId,
                    severity: 'error',
                    code: 'hub-message-action-undeclared',
                    message: `Hub message action ${action.id} was registered but is not declared in the plugin manifest.`
                })
            }
            if (seenMessageActionIds.has(action.id)) {
                diagnostics.push({
                    pluginId,
                    severity: 'error',
                    code: 'hub-message-action-duplicate',
                    message: `Hub message action ${action.id} was registered more than once.`
                })
            }
            seenMessageActionIds.add(action.id)
        }
        return diagnostics
    }

    private async computeSignature(record: DiscoveredPluginRecord): Promise<string> {
        const hubEntry = record.runtimeEntryPaths.find((entry) => entry.runtime === 'hub')
        return stableStringify({
            manifestPath: record.manifestPath,
            manifestMtime: await safeMtime(record.manifestPath),
            hubEntry: hubEntry?.realPath,
            hubEntryMtime: hubEntry ? await safeMtime(hubEntry.realPath) : 0,
            config: record.config ?? {},
            pluginApiVersion: record.manifest?.pluginApiVersion,
            version: record.manifest?.version
        })
    }

    private sanitizeRuntimeDiagnostic(pluginId: string, value: unknown): string {
        const declaredSecrets = this.activePlugins.get(pluginId)?.record.manifest?.permissions?.secrets
            ?? this.records.find((record) => record.manifest?.id === pluginId)?.manifest?.permissions?.secrets
            ?? []
        return redactText(errorMessage(value), declaredSecrets, this.options.env ?? process.env)
    }

    private async disposeActive(pluginId: string): Promise<void> {
        const existing = this.activePlugins.get(pluginId)
        if (!existing) {
            return
        }
        this.activePlugins.delete(pluginId)
        await existing.registry.dispose()
    }

    private async findDiscoveredRecord(id: string): Promise<DiscoveredPluginRecord | null> {
        const discovered = await this.discoverPluginRecords()
        return discovered.find((record) => pluginDisplayId(record) === id || record.manifest?.id === id) ?? null
    }

    private async discoverPluginRecords(): Promise<DiscoveredPluginRecord[]> {
        const bundledDisabled = (this.options.env ?? process.env).HAPI_DISABLE_BUNDLED_EXAMPLE_PLUGINS === '1'
        if (this.options.includeBundledCore === true) {
            await seedDefaultFirstPartyPluginsAsUserPlugins(this.options.hapiHome)
        }
        const bundledPluginDirs = [
            ...(this.options.includeBundledExamples && !bundledDisabled ? [await prepareBundledExamplePlugins(this.options.hapiHome)] : [])
        ]
        const records = await discoverPlugins({
            hapiHome: this.options.hapiHome,
            envPluginDirs: this.options.envPluginDirs ?? this.options.env?.HAPI_PLUGIN_DIRS,
            bundledPluginDirs
        })
        return applyRuntimeCompatibility(
            records.filter((record) => !record.manifest || record.source !== 'bundled' || pluginManifestRequiresHubInstall(record.manifest)),
            'hub',
            this.hostInfo()
        )
    }

    private defaultEnabledPluginIds(): string[] {
        return []
    }

    private hostInfo(): PluginHostInfo {
        return {
            runtime: 'hub',
            hapiVersion: packageJson.version,
            pluginApiVersion: HAPI_PLUGIN_API_VERSION,
            supportedPluginApiVersions: [...HAPI_SUPPORTED_PLUGIN_API_VERSIONS],
            os: process.platform,
            arch: process.arch,
            supportedExtensionPoints: [...HUB_IMPLEMENTED_EXTENSION_POINTS]
        }
    }

    private currentNoopResult(targetId: string): PluginReloadResult {
        return {
            ok: true,
            targetId,
            results: [{ id: targetId, action: 'unchanged', status: this.activePlugins.has(targetId) ? 'active' : 'enabled', diagnostics: [] }],
            plugins: this.listPlugins()
        }
    }

    private toListItem(record: DiscoveredPluginRecord): PluginListItem {
        const id = pluginDisplayId(record)
        const active = record.manifest && record.status !== 'blocked' ? this.activePlugins.has(record.manifest.id) : false
        const activeInstance = record.manifest ? this.activePlugins.get(record.manifest.id) : undefined
        const configScope = record.manifest && record.status !== 'blocked' ? hubPluginConfigScope(record.manifest.id) : undefined
        return {
            id,
            name: record.manifest?.name,
            version: record.manifest?.version,
            description: record.manifest?.description,
            display: record.manifest?.display,
            source: record.source,
            status: active && record.status === 'enabled' ? 'active' : record.status,
            enabled: record.enabled === true,
            active,
            rootPath: record.rootPath,
            manifestPath: record.manifestPath,
            runtimes: {
                ...(record.manifest?.runtimes?.hub ? {
                    hub: {
                        entry: record.manifest.runtimes.hub.entry,
                        active
                    }
                } : {}),
                ...(record.manifest?.runtimes?.runner ? {
                    runner: {
                        entry: record.manifest.runtimes.runner.entry,
                        active: false
                    }
                } : {})
            },
            diagnostics: [
                ...record.diagnostics.map((entry) => diagnosticView(id, entry)),
                ...this.missingSecretDiagnostics(record),
                ...(activeInstance?.registry.diagnostics.map((entry) => diagnosticView(id, entry)) ?? [])
            ],
            ...(configScope ? { configScope } : {}),
            install: record.install ?? { sourceType: record.source, version: record.manifest?.version },
            ...(activeInstance ? { updatedAt: activeInstance.loadedAt } : {})
        }
    }

    private toDetail(record: DiscoveredPluginRecord): PluginDetail {
        const item = this.toListItem(record)
        const declaredSecrets = record.manifest?.permissions?.secrets ?? []
        const sanitizedConfig = sanitizePluginConfigForView(record.config, declaredSecrets)
        const configScope = record.manifest && record.status !== 'blocked' ? hubPluginConfigScope(record.manifest.id) : undefined
        return {
            ...item,
            manifest: record.manifest,
            config: sanitizedConfig,
            ...(configScope && record.manifest ? {
                configMetadata: {
                    scope: configScope,
                    pluginId: record.manifest.id,
                    runtime: 'hub',
                    target: this.targetSummary(),
                    config: sanitizedConfig ?? {},
                    ...(record.configUpdatedAt ? { updatedAt: record.configUpdatedAt } : {}),
                    source: record.configSource ?? 'empty'
                }
            } : {}),
            permissions: {
                network: record.manifest?.permissions?.network ?? [],
                secrets: this.secretStatuses(record)
            },
            contributions: {
                notificationChannels: record.manifest?.contributions?.hub?.notificationChannels ?? [],
                ...(record.manifest?.contributions?.hub?.messageActions ? { messageActions: record.manifest.contributions.hub.messageActions } : {}),
                ...(record.manifest?.contributions?.runner ? { runner: record.manifest.contributions.runner } : {}),
                ...(record.manifest?.contributions?.agent ? { agent: record.manifest.contributions.agent } : {}),
                ...(record.manifest?.contributions?.voice ? { voice: record.manifest.contributions.voice } : {}),
                ...(record.manifest?.contributions?.deployment ? { deployment: record.manifest.contributions.deployment } : {}),
                ...(record.manifest?.contributions?.integration ? { integration: record.manifest.contributions.integration } : {}),
                ...(record.manifest?.contributions?.web ? { web: record.manifest.contributions.web } : {})
            },
            runtimeEntryPaths: record.runtimeEntryPaths
        }
    }

    private targetSummary(): PluginTargetSummary {
        return {
            scope: 'hub',
            runtime: 'hub',
            active: true,
            stale: false,
            displayName: 'Hub',
            updatedAt: Date.now()
        }
    }

    private hubPartStatus(record: DiscoveredPluginRecord, part: PluginCapabilityPart): PluginCapabilityPartStatus {
        const pluginId = record.manifest?.id
        const target = this.targetSummary()
        if (!pluginId || record.enabled !== true) {
            return {
                status: 'disabled',
                target,
                required: part.required,
                declared: true,
                registered: false,
                active: false,
                diagnostics: []
            }
        }
        if (!record.manifest?.runtimes?.hub) {
            return {
                status: 'missing-target',
                target,
                required: part.required,
                declared: true,
                registered: false,
                active: false,
                diagnostics: []
            }
        }
        const instance = this.activePlugins.get(pluginId)
        const diagnostics = [
            ...record.diagnostics.map((entry) => diagnosticView(pluginId, entry)),
            ...(instance?.registry.diagnostics.map((entry) => diagnosticView(pluginId, entry)) ?? [])
        ]
        if (!instance) {
            return {
                status: record.status === 'failed' || record.status === 'reload-failed' ? 'failed' : 'partial',
                target,
                required: part.required,
                declared: true,
                registered: false,
                active: false,
                diagnostics
            }
        }
        const actionIds = new Set(instance.registry.getMessageActions().map((entry) => entry.id))
        const registered = part.contributions.every((contribution) => {
            if (contribution.type === 'messageAction') {
                return actionIds.has(contribution.id)
            }
            if (contribution.type === 'notificationChannel') {
                return true
            }
            return false
        })
        return {
            status: registered ? 'ready' : 'partial',
            target,
            required: part.required,
            declared: true,
            registered,
            active: registered,
            diagnostics
        }
    }

    private secretStatuses(record: DiscoveredPluginRecord) {
        const target = this.targetSummary()
        const pluginId = record.manifest?.id
        const configScope = pluginId ? hubPluginConfigScope(pluginId) : undefined
        return (record.manifest?.permissions?.secrets ?? []).map((name) => ({
            name,
            present: Boolean((this.options.env ?? process.env)[name]),
            required: true,
            lastChecked: Date.now(),
            target,
            ...(configScope ? { configScope } : {})
        }))
    }

    private missingSecretDiagnostics(record: DiscoveredPluginRecord): PluginDiagnosticView[] {
        if (!record.manifest || record.enabled !== true) {
            return []
        }
        if (this.activePlugins.has(record.manifest.id)) {
            return []
        }
        const target = this.targetSummary()
        const configScope = hubPluginConfigScope(record.manifest.id)
        return (record.manifest.permissions?.secrets ?? [])
            .filter((name) => !((this.options.env ?? process.env)[name]))
            .map((name) => ({
                pluginId: record.manifest!.id,
                severity: 'warning' as const,
                code: 'plugin-secret-missing',
                message: `Missing required secret ${name} for ${target.scope}. Set it in the Hub runtime environment.`,
                target,
                configScope
            }))
    }

    private resetWatchers(): void {
        if (this.options.watch === false || this.disposed) {
            return
        }
        this.clearWatchers()
        const paths = new Set<string>([
            this.options.hapiHome,
            join(this.options.hapiHome, 'plugins'),
            ...this.records.map((record) => record.rootPath),
            ...this.records.flatMap((record) => record.runtimeEntryPaths.map((entry) => dirname(entry.realPath)))
        ])
        for (const path of paths) {
            try {
                const watcher = watch(path, { persistent: false }, (_eventType, filename) => {
                    if (filename && basename(String(filename)).startsWith('.hapi-reload-')) {
                        return
                    }
                    this.scheduleWatchReload()
                })
                this.watchers.push(watcher)
            } catch {
                // Watch support is best-effort; manual reload remains available.
            }
        }
    }

    private clearWatchers(): void {
        for (const watcher of this.watchers) {
            watcher.close()
        }
        this.watchers = []
    }

    private scheduleWatchReload(): void {
        if (this.disposed) {
            return
        }
        if (this.watchTimer) {
            clearTimeout(this.watchTimer)
        }
        this.watchTimer = setTimeout(() => {
            this.watchTimer = null
            this.reload(undefined, 'watch').catch((error) => {
                console.error('[HubPluginManager] Watch reload failed:', error)
            })
        }, this.options.watchDebounceMs ?? 300)
    }
}
