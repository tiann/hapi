import { basename } from 'node:path'
import type {
    PluginCapabilityPart,
    PluginCapabilityPartStatus,
    PluginCapabilityView,
    PluginDeleteResult,
    PluginDetail,
    PluginDiagnosticView,
    PluginInstallLocalRequest,
    PluginInstallPackageRequest,
    PluginInstallResult,
    PluginLocalDirectoryListResponse,
    PluginListItem,
    PluginHostInfo,
    PluginReloadItem,
    PluginReloadResult,
    PluginRuntimeContributionState,
    PluginTargetSummary,
    PluginWebContributionView,
    RunnerPluginInventory,
    RunnerPluginActionInvokeRequest,
    RunnerPluginActionInvokeResponse,
    RunnerPluginUnsupportedInstallResult
} from '@hapi/protocol/plugins'
import {
    AgentCapabilityProviderResultSchema,
    AgentCapabilityProviderSnapshotSchema,
    AgentHistoryImportResultSchema,
    AgentDescriptorSchema,
    HAPI_PLUGIN_API_VERSION,
    HAPI_SUPPORTED_PLUGIN_API_VERSIONS,
    builtinAgentDescriptors,
    hubPluginConfigScope,
    pluginManifestRequiresRunnerInstall,
    runnerPluginConfigScope,
    sanitizePluginConfigForView
} from '@hapi/protocol/plugins'
import { seedDefaultFirstPartyPluginsAsUserPlugins } from '@hapi/protocol/plugins/bundledCore'
import packageJson from '../../../package.json'
import { prepareBundledExamplePlugins } from '@hapi/protocol/plugins/bundledExamples'
import {
    applyPluginState,
    discoverPlugins,
    getPluginStateFile,
    readPluginState,
    resolvePluginScopedConfig,
    type DiscoveredPluginRecord
} from '@hapi/protocol/plugins/foundation'
import { RUNNER_IMPLEMENTED_EXTENSION_POINTS } from '@hapi/protocol/plugins/extensionPoints'
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
import { RunnerPluginRegistry, type RegisteredRuntimeContribution, type RunnerAgentAdapterContribution, type RunnerAgentCapabilityProviderContribution } from './runnerPluginRegistry'
import type { HappyCliSpawnPlan } from '@/utils/spawnHappyCLI'
import type { SpawnSessionOptions } from '@/modules/common/rpcTypes'
import type { AgentBackendFactory } from '@/agent/types'
import {
    resolveRunnerPluginSpawnOptions,
    resolveRunnerPluginSpawnPlan,
    runRunnerPluginAfterSpawnHooks,
    runRunnerPluginExitHooks,
    type RegisteredRunnerContribution,
    type RunnerCommandResolverContribution,
    type RunnerEnvironmentProviderContribution,
    type RunnerPluginDiagnosticSanitizer,
    type RunnerSpawnOptionsProviderContribution,
    type RunnerSpawnHookContribution
} from './runnerExtensionPipeline'
import type { AgentCapabilityProviderResult, AgentCapabilityProviderSnapshot, AgentHistoryImportResult, AgentDescriptor, PluginStateFile, RunnerResolvedSpawnOptions, RunnerResolvedSpawnPlan, RunnerSpawnContext } from '@hapi/protocol/plugins'

export interface RunnerPluginManagerOptions {
    hapiHome: string
    machineId: string
    envPluginDirs?: string
    env?: NodeJS.ProcessEnv
    includeBundledCore?: boolean
    includeBundledExamples?: boolean
    activationTimeoutMs?: number
}

type ActiveRunnerPluginInstance = {
    pluginId: string
    registry: RunnerPluginRegistry
    record: DiscoveredPluginRecord
    signature: string
    loadedAt: number
}

type ReloadReason = 'startup' | 'manual' | 'state-change'
type RunnerExtensionRuntimeContributionType = Exclude<RegisteredRuntimeContribution['type'], 'agentAdapter' | 'agentCapabilityProvider' | 'action'>
const BUILTIN_AGENT_IDS = new Set(builtinAgentDescriptors().map((descriptor) => descriptor.id))
const DEFAULT_CAPABILITY_PROVIDER_TIMEOUT_MS = 1000

function runtimeContributionSort<T>(
    left: RegisteredRunnerContribution<T>,
    right: RegisteredRunnerContribution<T>
): number {
    return left.priority - right.priority
        || left.pluginId.localeCompare(right.pluginId)
        || left.id.localeCompare(right.id)
        || left.order - right.order
}

type InternalReloadResult = {
    records: DiscoveredPluginRecord[]
    items: PluginReloadItem[]
}

function describeZodError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
            return `${path}${issue.message}`
        })
        .join('; ')
}

function withTimeout<T>(work: Promise<T> | T, timeoutMs: number, label: string): Promise<T> {
    let timeout: NodeJS.Timeout | null = null
    return Promise.race([
        Promise.resolve(work),
        new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        })
    ]).finally(() => {
        if (timeout) clearTimeout(timeout)
    })
}

function pluginDisplayId(record: DiscoveredPluginRecord): string {
    return record.manifest?.id ?? basename(record.rootPath)
}

function mergeContributionDetails<TManifest extends { id: string }, TActive extends { id: string }>(
    manifestEntries: TManifest[] | undefined,
    activeEntries: TActive[] | undefined
): Array<TManifest | (TManifest & TActive) | TActive> {
    const activeById = new Map((activeEntries ?? []).map((entry) => [entry.id, entry]))
    const merged: Array<TManifest | (TManifest & TActive) | TActive> = (manifestEntries ?? []).map((entry) => ({
        ...entry,
        ...(activeById.get(entry.id) ?? {})
    }))
    const declaredIds = new Set((manifestEntries ?? []).map((entry) => entry.id))
    merged.push(...(activeEntries ?? []).filter((entry) => !declaredIds.has(entry.id)))
    return merged
}

function hasDeclaredWebContributions(record: DiscoveredPluginRecord): boolean {
    const web = record.manifest?.contributions?.web
    if (!web) return false
    return Object.values(web as Record<string, unknown>).some((entry) => Array.isArray(entry) ? entry.length > 0 : Boolean(entry))
}

export class RunnerPluginManager {
    private readonly activePlugins = new Map<string, ActiveRunnerPluginInstance>()
    private readonly stateController: PluginRuntimeStateController
    private records: DiscoveredPluginRecord[] = []
    private managerDiagnostics: PluginDiagnosticView[] = []
    private capabilitySnapshots: AgentCapabilityProviderSnapshot[] = []
    private reloadQueue: Promise<InternalReloadResult> = Promise.resolve({ records: [], items: [] })
    private disposed = false
    private lastInventoryUpdatedAt = Date.now()

    constructor(private readonly options: RunnerPluginManagerOptions) {
        this.stateController = new PluginRuntimeStateController({
            hapiHome: options.hapiHome,
            configScope: (pluginId) => runnerPluginConfigScope(options.machineId, pluginId),
            defaultEnabledPluginIds: () => this.defaultEnabledPluginIds(),
            displayId: pluginDisplayId
        })
    }

    async start(): Promise<PluginReloadResult> {
        return await this.reload(undefined, 'startup')
    }

    listPlugins(): PluginListItem[] {
        return this.records.map((record) => this.toListItem(record))
    }

    getPlugin(id: string): PluginDetail | null {
        const record = this.records.find((entry) => pluginDisplayId(entry) === id || entry.manifest?.id === id)
        return record ? this.toDetail(record) : null
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

    getInventory(): RunnerPluginInventory {
        return {
            machineId: this.options.machineId,
            updatedAt: this.lastInventoryUpdatedAt,
            hostInfo: this.hostInfo(),
            plugins: this.listPlugins(),
            diagnostics: this.getDiagnostics(),
            extensions: {
                spawnOptionsProviders: this.collectContributionSummaries('spawnOptionsProvider'),
                environmentProviders: this.collectContributionSummaries('environmentProvider'),
                commandResolvers: this.collectContributionSummaries('commandResolver'),
                spawnHooks: this.collectContributionSummaries('spawnHook')
            },
            webContributions: this.collectWebContributions(),
            contributionStates: this.collectContributionStates(),
            capabilities: this.collectCapabilities()
        }
    }

    collectContributionStates(): PluginRuntimeContributionState[] {
        const target = this.targetSummary()
        return this.records
            .filter((record) => record.manifest)
            .flatMap((record) => {
                const pluginId = record.manifest!.id
                const registry = this.activePlugins.get(pluginId)?.registry
                const enabled = record.enabled === true
                const diagnostics = [
                    ...record.diagnostics.map((entry) => diagnosticView(pluginId, entry)),
                    ...(registry?.diagnostics.map((entry) => diagnosticView(pluginId, entry)) ?? [])
                ]
                const makeState = (type: string, id: string, registered: boolean): PluginRuntimeContributionState => ({
                    pluginId,
                    target,
                    runtime: 'runner',
                    contributionType: type,
                    contributionId: id,
                    declared: true,
                    registered,
                    active: enabled && registered,
                    diagnostics
                })

                const states: PluginRuntimeContributionState[] = []
                for (const contribution of record.manifest!.contributions?.runner?.spawnOptionsProviders ?? []) {
                    states.push(makeState('spawnOptionsProvider', contribution.id, Boolean(registry?.getSpawnOptionsProviders().some((entry) => entry.id === contribution.id))))
                }
                for (const contribution of record.manifest!.contributions?.runner?.environmentProviders ?? []) {
                    states.push(makeState('environmentProvider', contribution.id, Boolean(registry?.getEnvironmentProviders().some((entry) => entry.id === contribution.id))))
                }
                for (const contribution of record.manifest!.contributions?.runner?.commandResolvers ?? []) {
                    states.push(makeState('commandResolver', contribution.id, Boolean(registry?.getCommandResolvers().some((entry) => entry.id === contribution.id))))
                }
                for (const contribution of record.manifest!.contributions?.runner?.spawnHooks ?? []) {
                    states.push(makeState('spawnHook', contribution.id, Boolean(registry?.getSpawnHooks().some((entry) => entry.id === contribution.id))))
                }
                for (const contribution of record.manifest!.contributions?.agent?.adapters ?? []) {
                    states.push(makeState('agentAdapter', contribution.id, Boolean(registry?.getAgentAdapters().some((entry) => entry.id === contribution.id))))
                }
                for (const contribution of record.manifest!.contributions?.agent?.capabilityProviders ?? []) {
                    states.push(makeState('agentCapabilityProvider', contribution.id, Boolean(registry?.getAgentCapabilityProviders().some((entry) => entry.id === contribution.id))))
                }
                const actionIds = new Set(record.manifest!.capabilities
                    ?.flatMap((capability) => capability.parts.runner?.contributions ?? [])
                    .filter((contribution) => contribution.type === 'action')
                    .map((contribution) => contribution.id) ?? [])
                for (const actionId of actionIds) {
                    states.push(makeState('action', actionId, Boolean(registry?.getActions().some((entry) => entry.id === actionId))))
                }
                return states
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
                    ...(capability.parts.hub ? {
                        hub: {
                            status: 'missing-target' as const,
                            required: capability.parts.hub.required,
                            declared: true,
                            registered: false,
                            active: false,
                            diagnostics: []
                        }
                    } : {}),
                    ...(capability.parts.runner ? { runner: this.runnerPartStatus(record, capability.parts.runner) } : {})
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

    async invokeAction(args: RunnerPluginActionInvokeRequest): Promise<RunnerPluginActionInvokeResponse> {
        const instance = this.activePlugins.get(args.pluginId)
        const action = instance?.registry.getActions().find((entry) => entry.id === args.actionId)
        if (!action) {
            return {
                ok: false,
                code: 'plugin-action-not-active',
                message: `Runner plugin action ${args.pluginId}:${args.actionId} is not active on ${this.options.machineId}.`
            }
        }
        try {
            const result = await action.contribution.run({
                namespace: args.namespace,
                machineId: this.options.machineId,
                sessionId: args.sessionId,
                cwd: args.cwd,
                payload: args.payload,
                capabilityId: args.capabilityId,
                actionId: args.actionId
            })
            return result.ok === false
                ? { ...result, message: this.sanitizeRuntimeDiagnostic(args.pluginId, result.message) }
                : result
        } catch (error) {
            return {
                ok: false,
                code: 'plugin-action-failed',
                message: this.sanitizeRuntimeDiagnostic(args.pluginId, error)
            }
        }
    }

    getAgentDescriptors(): AgentDescriptor[] {
        const pluginDescriptors = this.collectAgentAdapters().map((entry) => AgentDescriptorSchema.parse({
            ...entry.contribution.descriptor,
            source: 'plugin',
            pluginId: entry.pluginId,
            available: true
        }))
        const firstById = new Map<string, AgentDescriptor>()
        for (const descriptor of [...builtinAgentDescriptors(), ...pluginDescriptors]) {
            if (!firstById.has(descriptor.id)) {
                firstById.set(descriptor.id, descriptor)
            }
        }
        for (const snapshot of this.capabilitySnapshots) {
            const descriptor = firstById.get(snapshot.agentId)
            if (!descriptor) {
                continue
            }
            const modelIds = [
                ...(descriptor.capabilities.models ?? []),
                ...(snapshot.capabilities.models ?? []).map((model) => model.id)
            ]
            firstById.set(snapshot.agentId, AgentDescriptorSchema.parse({
                ...descriptor,
                capabilities: {
                    ...descriptor.capabilities,
                    models: Array.from(new Set(modelIds))
                }
            }))
        }
        return Array.from(firstById.values())
    }

    getAgentDescriptor(agentId: string): AgentDescriptor | null {
        return this.getAgentDescriptors().find((descriptor) => descriptor.id === agentId) ?? null
    }

    getAgentAdapterFactory(agentId: string): AgentBackendFactory | null {
        const match = this.collectAgentAdapters().find((entry) => entry.contribution.descriptor.id === agentId)
        return match?.contribution.createBackend ?? null
    }

    getAgentCapabilities(): AgentCapabilityProviderSnapshot[] {
        return this.capabilitySnapshots.map((snapshot) => AgentCapabilityProviderSnapshotSchema.parse(snapshot))
    }

    async importAgentHistory(args: { agentId: string; nativeSessionId: string; providerId?: string }): Promise<AgentHistoryImportResult> {
        const providers = this.collectAgentCapabilityProviders()
            .filter((entry) => entry.contribution.agentId === args.agentId)
            .filter((entry) => this.getPluginOwnedAgentDescriptor(entry.contribution.agentId, entry.pluginId))
            .filter((entry) => !args.providerId || entry.id === args.providerId)
            .filter((entry) => typeof entry.contribution.importHistory === 'function')
        if (providers.length === 0) {
            throw new Error(`No history importer is active for agent ${args.agentId}.`)
        }

        const provider = providers[0]
        try {
            const raw = await withTimeout(
                provider.contribution.importHistory!({
                    machineId: this.options.machineId,
                    agentId: args.agentId,
                    nativeSessionId: args.nativeSessionId
                }),
                DEFAULT_CAPABILITY_PROVIDER_TIMEOUT_MS,
                `${provider.pluginId}:${provider.id} history importer`
            )
            const parsed = AgentHistoryImportResultSchema.safeParse(raw)
            if (!parsed.success) {
                throw new Error(`history importer returned invalid messages: ${describeZodError(parsed.error)}`)
            }
            return parsed.data
        } catch (error) {
            const message = this.sanitizeRuntimeDiagnostic(provider.pluginId, error)
            this.recordDiagnostics([{
                pluginId: provider.pluginId,
                severity: 'warning',
                code: 'agent-history-import-failed',
                message: `[runner-plugin:${this.options.machineId}:${provider.pluginId}] ${provider.id} history importer failed: ${message}`
            }])
            throw new Error(message)
        }
    }

    async resolveSpawnPlan(args: {
        options: SpawnSessionOptions
        agent: string
        basePlan: HappyCliSpawnPlan
        cwd: string
        env: NodeJS.ProcessEnv
    }): Promise<RunnerResolvedSpawnPlan> {
        const result = await resolveRunnerPluginSpawnPlan({
            machineId: this.options.machineId,
            options: args.options,
            agent: args.agent,
            basePlan: {
                command: args.basePlan.command,
                args: args.basePlan.args,
                displayArgs: args.basePlan.displayArgs,
                mode: args.basePlan.mode,
                cwd: args.cwd,
                env: args.env
            },
            environmentProviders: this.collectEnvironmentProviders(),
            commandResolvers: this.collectCommandResolvers(),
            spawnHooks: this.collectSpawnHooks(),
            sanitizeDiagnostic: this.runtimeDiagnosticSanitizer()
        })
        this.recordDiagnostics([
            ...result.diagnostics,
            ...result.audit.map((entry) => ({
                severity: 'info' as const,
                code: 'runner-extension-audit',
                pluginId: entry.pluginId,
                message: `[runner-plugin:${this.options.machineId}:${entry.pluginId}] ${entry.message}`
            }))
        ])
        return result
    }

    async resolveSpawnOptions(args: {
        options: SpawnSessionOptions
        agent: string
        cwd: string
    }): Promise<RunnerResolvedSpawnOptions> {
        const result = await resolveRunnerPluginSpawnOptions({
            machineId: this.options.machineId,
            options: args.options,
            agent: args.agent,
            cwd: args.cwd,
            spawnOptionsProviders: this.collectSpawnOptionsProviders(),
            sanitizeDiagnostic: this.runtimeDiagnosticSanitizer()
        })
        this.recordDiagnostics([
            ...result.diagnostics,
            ...result.audit.map((entry) => ({
                severity: 'info' as const,
                code: 'runner-extension-audit',
                pluginId: entry.pluginId,
                message: `[runner-plugin:${this.options.machineId}:${entry.pluginId}] ${entry.message}`
            }))
        ])
        return result
    }

    async notifyAfterSpawn(args: { context: RunnerSpawnContext; pid: number }): Promise<void> {
        await runRunnerPluginAfterSpawnHooks({
            baseContext: args.context,
            pid: args.pid,
            hooks: this.collectSpawnHooks(),
            onDiagnostic: (diagnostic) => this.recordDiagnostics([diagnostic]),
            sanitizeDiagnostic: this.runtimeDiagnosticSanitizer()
        })
    }

    async notifyExit(args: { context: RunnerSpawnContext; pid: number; exitCode: number | null; signal: NodeJS.Signals | null }): Promise<void> {
        await runRunnerPluginExitHooks({
            baseContext: args.context,
            pid: args.pid,
            exitCode: args.exitCode,
            signal: args.signal,
            hooks: this.collectSpawnHooks(),
            onDiagnostic: (diagnostic) => this.recordDiagnostics([diagnostic]),
            sanitizeDiagnostic: this.runtimeDiagnosticSanitizer()
        })
    }

    async reload(targetId?: string, reason: ReloadReason = 'manual'): Promise<PluginReloadResult> {
        this.reloadQueue = this.reloadQueue
            .catch(() => ({ records: this.records, items: [] }))
            .then(() => this.performReload(targetId))
        const internal = await this.reloadQueue
        const target = this.targetSummary()
        return {
            ok: internal.items.every(reloadItemIsOk),
            ...(targetId ? { targetId } : {}),
            target,
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

    async installLocalPlugin(options: PluginInstallLocalRequest): Promise<PluginInstallResult> {
        const install = await this.stateController.installLocalPlugin(options, 'runner-local-path')
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

    installPrepareUnsupported(): RunnerPluginUnsupportedInstallResult {
        return {
            ok: false,
            code: 'unsupported-runtime',
            message: 'Legacy prepare/commit install RPC is not supported. Use runner.plugins.install-local or runner.plugins.install-package for target-scoped installs.'
        }
    }

    installCommitUnsupported(): RunnerPluginUnsupportedInstallResult {
        return this.installPrepareUnsupported()
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
            target: this.targetSummary(),
            ...(reloadResult ? { reload: reloadResult } : {}),
            plugins: this.listPlugins()
        }
    }

    async dispose(): Promise<void> {
        this.disposed = true
        const instances = Array.from(this.activePlugins.values()).reverse()
        this.activePlugins.clear()
        await Promise.all(instances.map(async (instance) => {
            try {
                await instance.registry.dispose()
            } catch (error) {
                console.error('[RunnerPluginManager] Plugin dispose failed:', error)
            }
        }))
    }

    private async performReload(targetId: string | undefined): Promise<InternalReloadResult> {
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
        const records = this.applyHubMirrorConfigFallbacks(this.stateController.applyScopedRuntimeConfig(applyPluginState(discovered, stateResult.state, {
            failClosed: stateResult.failClosed,
            defaultEnabledPluginIds: this.defaultEnabledPluginIds()
        }), stateResult.state), stateResult.state)

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
            runtime: 'runner',
            runtimeDisplayName: 'Runner',
            pluginDisplayId,
            computeSignature: (record) => this.computeSignature(record),
            activateRecord: (record, signature) => this.activateRecord(record, signature),
            disposeActive: (pluginId) => this.disposeActive(pluginId),
            disposeInstance: (instance) => instance.registry.dispose(),
            shouldDiscardActivatedInstance: () => this.disposed,
            discardedActivationMessage: 'Runner plugin manager disposed during activation.'
        }))

        const capabilityResult = await this.collectAgentCapabilitySnapshots()
        managerDiagnostics.push(...capabilityResult.diagnostics)
        this.capabilitySnapshots = capabilityResult.snapshots
        this.records = records
        this.managerDiagnostics = managerDiagnostics
        this.lastInventoryUpdatedAt = Date.now()
        return { records, items }
    }

    private applyHubMirrorConfigFallbacks(records: DiscoveredPluginRecord[], state: PluginStateFile): DiscoveredPluginRecord[] {
        return records.map((record) => {
            if (!record.manifest || record.status === 'blocked' || record.configSource !== 'empty') {
                return record
            }
            if (!record.manifest.runtimes?.runner || record.manifest.runtimes?.hub || !hasDeclaredWebContributions(record)) {
                return record
            }
            const resolved = resolvePluginScopedConfig(state.enabled[record.manifest.id], hubPluginConfigScope(record.manifest.id))
            if (!resolved.config) {
                return record
            }
            return {
                ...record,
                config: resolved.config,
                ...(resolved.updatedAt ? { configUpdatedAt: resolved.updatedAt } : {}),
                configSource: resolved.source
            }
        })
    }

    private async activateRecord(record: DiscoveredPluginRecord, signature: string) {
        return await activateRuntimeRecord({
            record,
            signature,
            runtime: 'runner',
            runtimeDisplayName: 'Runner',
            missingEntryCode: 'missing-runner-entry',
            invalidEntryCode: 'invalid-runner-entry',
            activationFailedCode: 'runner-plugin-activate-failed',
            activationFailureLabel: 'runner plugin',
            importQueryName: 'hapiRunnerPlugin',
            reloadMarker: 'hapi-runner-reload',
            reloadStrategy: 'entry-suffix',
            activationTimeoutMs: this.options.activationTimeoutMs,
            env: this.options.env,
            createRegistry: () => new RunnerPluginRegistry(this.options.machineId),
            createInstance: ({ pluginId, registry, record: activatedRecord, signature: activatedSignature, loadedAt }) => ({
                pluginId,
                registry,
                record: activatedRecord,
                signature: activatedSignature,
                loadedAt
            })
        })
    }

    private async computeSignature(record: DiscoveredPluginRecord): Promise<string> {
        const runnerEntry = record.runtimeEntryPaths.find((entry) => entry.runtime === 'runner')
        return stableStringify({
            manifestPath: record.manifestPath,
            manifestMtime: await safeMtime(record.manifestPath),
            runnerEntry: runnerEntry?.realPath,
            runnerEntryMtime: runnerEntry ? await safeMtime(runnerEntry.realPath) : 0,
            config: record.config ?? {},
            pluginApiVersion: record.manifest?.pluginApiVersion,
            version: record.manifest?.version
        })
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
            records.filter((record) => !record.manifest || pluginManifestRequiresRunnerInstall(record.manifest)),
            'runner',
            this.hostInfo()
        )
    }

    private defaultEnabledPluginIds(): string[] {
        return []
    }

    private hostInfo(): PluginHostInfo {
        return {
            runtime: 'runner',
            hapiVersion: packageJson.version,
            pluginApiVersion: HAPI_PLUGIN_API_VERSION,
            supportedPluginApiVersions: [...HAPI_SUPPORTED_PLUGIN_API_VERSIONS],
            os: process.platform,
            arch: process.arch,
            supportedExtensionPoints: [...RUNNER_IMPLEMENTED_EXTENSION_POINTS]
        }
    }

    private async buildInstallResult(options: {
        action: 'installed' | 'overwritten'
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
            target: this.targetSummary(),
            diagnostics: options.diagnostics ?? plugin?.diagnostics ?? [],
            ...(reloadResult ? { reload: reloadResult } : {}),
            plugins: this.listPlugins()
        }
    }

    private currentNoopResult(targetId: string): PluginReloadResult {
        return {
            ok: true,
            targetId,
            target: this.targetSummary(),
            results: [{ id: targetId, action: 'unchanged', status: this.activePlugins.has(targetId) ? 'active' : 'enabled', diagnostics: [] }],
            plugins: this.listPlugins()
        }
    }

    private targetSummary(): PluginTargetSummary {
        return {
            scope: `runner:${this.options.machineId}`,
            runtime: 'runner',
            machineId: this.options.machineId,
            active: true,
            stale: false,
            updatedAt: this.lastInventoryUpdatedAt,
            hostInfo: this.hostInfo()
        }
    }

    private recordDiagnostics(diagnostics: PluginDiagnosticView[]): void {
        for (const diagnostic of diagnostics) {
            this.managerDiagnostics.push({
                severity: diagnostic.severity,
                code: diagnostic.code,
                message: diagnostic.message,
                ...(diagnostic.pluginId ? { pluginId: diagnostic.pluginId } : {}),
                ...(diagnostic.path ? { path: diagnostic.path } : {})
            })
        }
        if (this.managerDiagnostics.length > 500) {
            this.managerDiagnostics = this.managerDiagnostics.slice(-500)
        }
        if (diagnostics.length > 0) {
            this.lastInventoryUpdatedAt = Date.now()
        }
    }

    private runtimeDiagnosticSanitizer(): RunnerPluginDiagnosticSanitizer {
        return (pluginId, value) => this.sanitizeRuntimeDiagnostic(pluginId, value)
    }

    private sanitizeRuntimeDiagnostic(pluginId: string, value: unknown): string {
        const declaredSecrets = this.activePlugins.get(pluginId)?.record.manifest?.permissions?.secrets
            ?? this.records.find((record) => record.manifest?.id === pluginId)?.manifest?.permissions?.secrets
            ?? []
        return redactText(errorMessage(value), declaredSecrets, this.options.env ?? process.env)
    }

    private async collectAgentCapabilitySnapshots(): Promise<{
        snapshots: AgentCapabilityProviderSnapshot[]
        diagnostics: PluginDiagnosticView[]
    }> {
        const snapshots: AgentCapabilityProviderSnapshot[] = []
        const diagnostics: PluginDiagnosticView[] = []

        for (const entry of this.collectAgentCapabilityProviders()) {
            const label = `${entry.pluginId}:${entry.id}`
            const ownedDescriptor = this.getPluginOwnedAgentDescriptor(entry.contribution.agentId, entry.pluginId)
            if (!ownedDescriptor) {
                diagnostics.push({
                    pluginId: entry.pluginId,
                    severity: 'warning',
                    code: 'agent-capability-provider-agent-not-owned',
                    message: `[runner-plugin:${this.options.machineId}:${entry.pluginId}] ${label} targets agent ${entry.contribution.agentId}, but providers can only target agent adapters from the same plugin.`
                })
                continue
            }

            if (!entry.contribution.provide) {
                continue
            }

            const updatedAt = Date.now()
            try {
                const raw = await withTimeout(
                    entry.contribution.provide({
                        machineId: this.options.machineId,
                        agentId: entry.contribution.agentId
                    }),
                    DEFAULT_CAPABILITY_PROVIDER_TIMEOUT_MS,
                    `${label} capability provider`
                )
                const parsed = AgentCapabilityProviderResultSchema.safeParse(raw)
                if (!parsed.success) {
                    throw new Error(`capability provider returned invalid descriptors: ${describeZodError(parsed.error)}`)
                }

                const sanitized = this.sanitizeCapabilityProviderResult(entry, parsed.data, ownedDescriptor)
                const providerDiagnostics = sanitized.diagnostics ?? []
                snapshots.push(AgentCapabilityProviderSnapshotSchema.parse({
                    agentId: entry.contribution.agentId,
                    pluginId: entry.pluginId,
                    contributionId: entry.id,
                    updatedAt,
                    capabilities: sanitized,
                    diagnostics: providerDiagnostics
                }))
                diagnostics.push(...providerDiagnostics.map((diagnostic) => ({
                    pluginId: entry.pluginId,
                    severity: diagnostic.severity,
                    code: diagnostic.code,
                    message: `[runner-plugin:${this.options.machineId}:${entry.pluginId}] ${diagnostic.message}`,
                    ...(diagnostic.path ? { path: diagnostic.path } : {})
                })))
            } catch (error) {
                const safeMessage = this.sanitizeRuntimeDiagnostic(entry.pluginId, error)
                const diagnostic = {
                    pluginId: entry.pluginId,
                    severity: 'warning' as const,
                    code: 'agent-capability-provider-failed',
                    message: `[runner-plugin:${this.options.machineId}:${entry.pluginId}] ${label} capability provider failed: ${safeMessage}`
                }
                diagnostics.push(diagnostic)
                snapshots.push(AgentCapabilityProviderSnapshotSchema.parse({
                    agentId: entry.contribution.agentId,
                    pluginId: entry.pluginId,
                    contributionId: entry.id,
                    updatedAt,
                    capabilities: {},
                    diagnostics: [{ severity: diagnostic.severity, code: diagnostic.code, message: diagnostic.message }]
                }))
            }
        }

        return { snapshots, diagnostics }
    }

    private getPluginOwnedAgentDescriptor(agentId: string, pluginId: string): AgentDescriptor | null {
        const adapter = this.collectAgentAdapters().find((entry) =>
            entry.pluginId === pluginId && entry.contribution.descriptor.id === agentId
        )
        return adapter ? AgentDescriptorSchema.parse({
            ...adapter.contribution.descriptor,
            source: 'plugin',
            pluginId,
            available: true
        }) : null
    }

    private sanitizeCapabilityProviderResult(
        entry: RegisteredRunnerContribution<RunnerAgentCapabilityProviderContribution>,
        result: AgentCapabilityProviderResult,
        ownerDescriptor: AgentDescriptor
    ): AgentCapabilityProviderResult {
        const providerDiagnostics = (result.diagnostics ?? []).map((diagnostic) => ({
            ...diagnostic,
            message: this.sanitizeRuntimeDiagnostic(entry.pluginId, diagnostic.message)
        }))
        const addDiagnostic = (code: string, message: string) => {
            providerDiagnostics.push({
                severity: 'warning' as const,
                code,
                message: this.sanitizeRuntimeDiagnostic(entry.pluginId, message)
            })
        }

        const allowedModes = new Set(ownerDescriptor.capabilities.permissionModes)
        const permissionModes = (result.permissionModes ?? []).filter((permissionMode) => {
            if (!allowedModes.has(permissionMode.mode)) {
                addDiagnostic(
                    'agent-capability-provider-permission-mode-not-owned',
                    `${entry.id} declared permission mode ${permissionMode.mode}, but the agent adapter descriptor does not allow it.`
                )
                return false
            }
            if ((permissionMode.mode === 'yolo' || permissionMode.mode === 'bypassPermissions') && permissionMode.risk !== 'danger') {
                addDiagnostic(
                    'agent-capability-provider-permission-mode-risk-missing',
                    `${entry.id} declared dangerous permission mode ${permissionMode.mode} without risk: danger.`
                )
                return false
            }
            return true
        })

        const usage = (result.usage ?? []).filter((usageEntry) => {
            if (usageEntry.scope === 'session' || usageEntry.sessionId) {
                addDiagnostic(
                    'agent-capability-provider-session-usage-rejected',
                    `${entry.id} returned session-scoped usage without a core session authorization context.`
                )
                return false
            }
            return true
        })

        return AgentCapabilityProviderResultSchema.parse({
            ...result,
            ...(permissionModes.length > 0 ? { permissionModes } : { permissionModes: undefined }),
            ...(usage.length > 0 ? { usage } : { usage: undefined }),
            diagnostics: providerDiagnostics
        })
    }

    private collectEnvironmentProviders(): RegisteredRunnerContribution<RunnerEnvironmentProviderContribution>[] {
        return this.collectRegistryContributions((registry) => registry.getEnvironmentProviders())
    }

    private collectSpawnOptionsProviders(): RegisteredRunnerContribution<RunnerSpawnOptionsProviderContribution>[] {
        return this.collectRegistryContributions((registry) => registry.getSpawnOptionsProviders())
    }

    private collectCommandResolvers(): RegisteredRunnerContribution<RunnerCommandResolverContribution>[] {
        return this.collectRegistryContributions((registry) => registry.getCommandResolvers())
    }

    private collectSpawnHooks(): RegisteredRunnerContribution<RunnerSpawnHookContribution>[] {
        return this.collectRegistryContributions((registry) => registry.getSpawnHooks())
    }

    private collectAgentAdapters(): RegisteredRunnerContribution<RunnerAgentAdapterContribution>[] {
        return this.collectRegistryContributions((registry) => registry.getAgentAdapters())
            .filter((entry) => !BUILTIN_AGENT_IDS.has(entry.contribution.descriptor.id))
            .sort(runtimeContributionSort)
    }

    private collectAgentCapabilityProviders(): RegisteredRunnerContribution<RunnerAgentCapabilityProviderContribution>[] {
        return this.collectRegistryContributions((registry) => registry.getAgentCapabilityProviders())
            .sort(runtimeContributionSort)
    }

    private collectRegistryContributions<T>(
        getEntries: (registry: RunnerPluginRegistry) => RegisteredRuntimeContribution<T>[]
    ): RegisteredRunnerContribution<T>[] {
        return Array.from(this.activePlugins.values()).flatMap((instance) =>
            getEntries(instance.registry).map((entry) => ({
                pluginId: entry.pluginId,
                id: entry.id,
                order: entry.order,
                priority: entry.priority,
                contribution: entry.contribution
            }))
        )
    }

    private collectContributionSummaries(type: RunnerExtensionRuntimeContributionType) {
        return Array.from(this.activePlugins.values()).flatMap((instance) => {
            const entries = type === 'spawnOptionsProvider'
                ? instance.registry.getSpawnOptionsProviders()
                : type === 'environmentProvider'
                    ? instance.registry.getEnvironmentProviders()
                    : type === 'commandResolver'
                        ? instance.registry.getCommandResolvers()
                        : instance.registry.getSpawnHooks()
            return entries.map((entry) => ({
                pluginId: entry.pluginId,
                id: entry.id,
                order: entry.order,
                type,
                priority: entry.priority,
                active: true
            }))
        }).sort((left, right) =>
            left.priority - right.priority
            || left.pluginId.localeCompare(right.pluginId)
            || left.id.localeCompare(right.id)
            || left.order - right.order
        ).map(({ order: _order, ...entry }) => entry)
    }

    private collectWebContributions(): PluginWebContributionView[] {
        return this.records
            .filter((record) => record.enabled === true && record.manifest?.contributions?.web)
            .map((record) => ({
                pluginId: record.manifest!.id,
                pluginName: record.manifest!.name,
                target: this.targetSummary().scope,
                contributions: record.manifest!.contributions!.web!
            }))
    }

    private runnerPartStatus(record: DiscoveredPluginRecord, part: PluginCapabilityPart): PluginCapabilityPartStatus {
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
        if (!record.manifest?.runtimes?.runner) {
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
        const registered = part.contributions.every((contribution) => {
            if (contribution.type === 'spawnOptionsProvider') {
                return instance.registry.getSpawnOptionsProviders().some((entry) => entry.id === contribution.id)
            }
            if (contribution.type === 'environmentProvider') {
                return instance.registry.getEnvironmentProviders().some((entry) => entry.id === contribution.id)
            }
            if (contribution.type === 'commandResolver') {
                return instance.registry.getCommandResolvers().some((entry) => entry.id === contribution.id)
            }
            if (contribution.type === 'spawnHook') {
                return instance.registry.getSpawnHooks().some((entry) => entry.id === contribution.id)
            }
            if (contribution.type === 'agentAdapter') {
                return instance.registry.getAgentAdapters().some((entry) => entry.id === contribution.id)
            }
            if (contribution.type === 'agentCapabilityProvider') {
                return instance.registry.getAgentCapabilityProviders().some((entry) => entry.id === contribution.id)
            }
            if (contribution.type === 'action') {
                return instance.registry.getActions().some((entry) => entry.id === contribution.id)
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


    private toListItem(record: DiscoveredPluginRecord): PluginListItem {
        const id = pluginDisplayId(record)
        const active = record.manifest && record.status !== 'blocked' ? this.activePlugins.has(record.manifest.id) : false
        const activeInstance = record.manifest ? this.activePlugins.get(record.manifest.id) : undefined
        const configScope = record.manifest && record.status !== 'blocked' ? runnerPluginConfigScope(this.options.machineId, record.manifest.id) : undefined
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
                        active: false
                    }
                } : {}),
                ...(record.manifest?.runtimes?.runner ? {
                    runner: {
                        entry: record.manifest.runtimes.runner.entry,
                        active
                    }
                } : {})
            },
            diagnostics: [
                ...record.diagnostics.map((entry) => diagnosticView(id, entry)),
                ...this.missingSecretDiagnostics(record),
                ...(activeInstance?.registry.diagnostics.map((entry) => diagnosticView(id, entry)) ?? []),
                ...this.managerDiagnostics.filter((entry) => entry.pluginId === id)
            ],
            target: this.targetSummary(),
            ...(configScope ? { configScope } : {}),
            install: record.install ?? { sourceType: record.source, version: record.manifest?.version },
            ...(activeInstance ? { updatedAt: activeInstance.loadedAt } : {})
        }
    }

    private toDetail(record: DiscoveredPluginRecord): PluginDetail {
        const item = this.toListItem(record)
        const declaredSecrets = record.manifest?.permissions?.secrets ?? []
        const activeInstance = record.manifest ? this.activePlugins.get(record.manifest.id) : undefined
        const sanitizedConfig = sanitizePluginConfigForView(record.config, declaredSecrets)
        const configScope = record.manifest && record.status !== 'blocked' ? runnerPluginConfigScope(this.options.machineId, record.manifest.id) : undefined
        const activeRunnerContributions = activeInstance ? {
            spawnOptionsProviders: activeInstance.registry.getSpawnOptionsProviders().map((entry) => ({
                id: entry.id,
                pluginId: entry.pluginId,
                priority: entry.priority,
                active: true
            })),
            environmentProviders: activeInstance.registry.getEnvironmentProviders().map((entry) => ({
                id: entry.id,
                pluginId: entry.pluginId,
                priority: entry.priority,
                active: true
            })),
            commandResolvers: activeInstance.registry.getCommandResolvers().map((entry) => ({
                id: entry.id,
                pluginId: entry.pluginId,
                priority: entry.priority,
                active: true
            })),
            spawnHooks: activeInstance.registry.getSpawnHooks().map((entry) => ({
                id: entry.id,
                pluginId: entry.pluginId,
                priority: entry.priority,
                active: true
            }))
        } : undefined
        const activeAgentContributions = activeInstance ? {
            adapters: activeInstance.registry.getAgentAdapters().map((entry) => ({
                id: entry.id,
                agentId: entry.contribution.descriptor.id,
                pluginId: entry.pluginId,
                priority: entry.priority,
                active: true
            })),
            capabilityProviders: activeInstance.registry.getAgentCapabilityProviders().map((entry) => ({
                id: entry.id,
                agentId: entry.contribution.agentId,
                pluginId: entry.pluginId,
                priority: entry.priority,
                active: true
            }))
        } : undefined
        const manifestRunnerContributions = record.manifest?.contributions?.runner
        const manifestAgentContributions = record.manifest?.contributions?.agent
        return {
            ...item,
            manifest: record.manifest,
            config: sanitizedConfig,
            ...(configScope && record.manifest ? {
                configMetadata: {
                    scope: configScope,
                    pluginId: record.manifest.id,
                    runtime: 'runner',
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
                ...(manifestRunnerContributions || activeRunnerContributions ? {
                    runner: {
                        ...(manifestRunnerContributions ?? {}),
                        ...(activeRunnerContributions ? {
                            spawnOptionsProviders: mergeContributionDetails(
                                manifestRunnerContributions?.spawnOptionsProviders,
                                activeRunnerContributions.spawnOptionsProviders
                            ),
                            environmentProviders: mergeContributionDetails(
                                manifestRunnerContributions?.environmentProviders,
                                activeRunnerContributions.environmentProviders
                            ),
                            commandResolvers: mergeContributionDetails(
                                manifestRunnerContributions?.commandResolvers,
                                activeRunnerContributions.commandResolvers
                            ),
                            spawnHooks: mergeContributionDetails(
                                manifestRunnerContributions?.spawnHooks,
                                activeRunnerContributions.spawnHooks
                            )
                        } : {})
                    }
                } : {}),
                ...(manifestAgentContributions || activeAgentContributions ? {
                    agent: {
                        ...(manifestAgentContributions ?? {}),
                        ...(activeAgentContributions ? {
                            adapters: mergeContributionDetails(
                                manifestAgentContributions?.adapters,
                                activeAgentContributions.adapters
                            ),
                            capabilityProviders: mergeContributionDetails(
                                manifestAgentContributions?.capabilityProviders,
                                activeAgentContributions.capabilityProviders
                            )
                        } : {})
                    }
                } : {}),
                ...(record.manifest?.contributions?.voice ? { voice: record.manifest.contributions.voice } : {}),
                ...(record.manifest?.contributions?.deployment ? { deployment: record.manifest.contributions.deployment } : {}),
                ...(record.manifest?.contributions?.integration ? { integration: record.manifest.contributions.integration } : {}),
                ...(record.manifest?.contributions?.web ? { web: record.manifest.contributions.web } : {})
            },
            runtimeEntryPaths: record.runtimeEntryPaths
        }
    }

    private secretStatuses(record: DiscoveredPluginRecord) {
        const target = this.targetSummary()
        const pluginId = record.manifest?.id
        const configScope = pluginId ? runnerPluginConfigScope(this.options.machineId, pluginId) : undefined
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
        const configScope = runnerPluginConfigScope(this.options.machineId, record.manifest.id)
        return (record.manifest.permissions?.secrets ?? [])
            .filter((name) => !((this.options.env ?? process.env)[name]))
            .map((name) => ({
                pluginId: record.manifest!.id,
                severity: 'warning' as const,
                code: 'plugin-secret-missing',
                message: `Missing required secret ${name} for ${target.scope}. Set it in the Runner runtime environment.`,
                target,
                configScope
            }))
    }
}
