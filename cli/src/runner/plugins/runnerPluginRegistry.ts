import { logger as runnerLogger } from '@/ui/logger'
import { AgentDescriptorSchema, AgentIdSchema, type PluginDiagnostic } from '@hapi/protocol/plugins'
import {
    PluginRuntimeRegistryBase,
    redactText,
    type RuntimeRegistryContribution
} from '@hapi/protocol/plugins/runtime/registryBase'
import type {
    Disposable,
    PluginConfigReader,
    PluginLogger,
    PluginSecretReader,
    RunnerAgentAdapterContribution,
    RunnerAgentCapabilityProviderContribution,
    RunnerCommandResolverContribution,
    RunnerEnvironmentProviderContribution,
    RunnerSpawnOptionsProviderContribution,
    RunnerPluginContext,
    RunnerPluginModule,
    RunnerPluginActionContribution,
    RunnerSpawnHookContribution
} from '@hapi/protocol/plugins'

export type {
    Disposable,
    PluginConfigReader,
    PluginLogger,
    PluginSecretReader,
    RunnerAgentAdapterContribution,
    RunnerAgentCapabilityProviderContribution,
    RunnerCommandResolverContribution,
    RunnerEnvironmentProviderContribution,
    RunnerSpawnOptionsProviderContribution,
    RunnerPluginActionContribution,
    RunnerPluginContext,
    RunnerPluginModule,
    RunnerSpawnHookContribution
} from '@hapi/protocol/plugins'

export type RunnerRuntimeContributionType = 'spawnOptionsProvider' | 'environmentProvider' | 'commandResolver' | 'spawnHook' | 'agentAdapter' | 'agentCapabilityProvider' | 'action'
export type RegisteredRuntimeContribution<T = unknown> = RuntimeRegistryContribution<RunnerRuntimeContributionType, T>

export class RunnerPluginRegistry extends PluginRuntimeRegistryBase<RunnerRuntimeContributionType> {
    private readonly disposeSecretState: { names: Set<string>; env: NodeJS.ProcessEnv }

    constructor(private readonly machineId: string) {
        const disposeSecretState = { names: new Set<string>(), env: process.env }
        super({
            registrationClosedMessage: 'Runner plugin runtime contributions can only be registered during activate(ctx).',
            diagnosticPrefix: (pluginId) => `[runner-plugin:${machineId}:${pluginId}]`,
            writeLog: (_level, pluginId, message, args) => {
                runnerLogger.debug(`[runner-plugin:${machineId}:${pluginId}] ${message}`, ...args)
            },
            onDisposeError: (error) => {
                runnerLogger.debug(`[RunnerPluginRegistry] Dispose failed on ${machineId}: ${redactText(error instanceof Error ? error.message : String(error), [...disposeSecretState.names], disposeSecretState.env)}`)
            }
        })
        this.disposeSecretState = disposeSecretState
    }

    createContext(args: {
        pluginId: string
        config?: Record<string, unknown>
        declaredSecrets?: string[]
        declaredNetwork?: string[]
        env?: NodeJS.ProcessEnv
    }): { ctx: RunnerPluginContext; close(): void } {
        this.disposeSecretState.env = args.env ?? process.env
        for (const secretName of args.declaredSecrets ?? []) {
            this.disposeSecretState.names.add(secretName)
        }
        const common = this.createCommonContextParts(args)
        const register = (type: RegisteredRuntimeContribution['type'], contribution: unknown): Disposable => {
            common.assertAccepting()
            return this.registerContribution(type, args.pluginId, validateContribution(type, contribution))
        }

        const ctx: RunnerPluginContext = {
            pluginId: args.pluginId,
            machineId: this.machineId,
            logger: common.logger,
            config: common.config,
            secrets: common.secrets,
            network: common.network,
            runtime: {
                registerSpawnOptionsProvider: (provider: unknown): Disposable => register('spawnOptionsProvider', provider),
                registerEnvironmentProvider: (provider: unknown): Disposable => register('environmentProvider', provider),
                registerCommandResolver: (resolver: unknown): Disposable => register('commandResolver', resolver),
                registerSpawnHook: (hook: unknown): Disposable => register('spawnHook', hook),
                registerAgentAdapter: (adapter: unknown): Disposable => register('agentAdapter', adapter),
                registerAgentCapabilityProvider: (provider: unknown): Disposable => register('agentCapabilityProvider', provider)
            },
            actions: {
                register: (action: unknown): Disposable => register('action', action)
            }
        }

        return {
            ctx,
            close: common.close
        }
    }

    getEnvironmentProviders(): RegisteredRuntimeContribution<RunnerEnvironmentProviderContribution>[] {
        return this.getContributionsByType('environmentProvider')
    }

    getSpawnOptionsProviders(): RegisteredRuntimeContribution<RunnerSpawnOptionsProviderContribution>[] {
        return this.getContributionsByType('spawnOptionsProvider')
    }

    getCommandResolvers(): RegisteredRuntimeContribution<RunnerCommandResolverContribution>[] {
        return this.getContributionsByType('commandResolver')
    }

    getSpawnHooks(): RegisteredRuntimeContribution<RunnerSpawnHookContribution>[] {
        return this.getContributionsByType('spawnHook')
    }

    getAgentAdapters(): RegisteredRuntimeContribution<RunnerAgentAdapterContribution>[] {
        return this.getContributionsByType('agentAdapter')
    }

    getAgentCapabilityProviders(): RegisteredRuntimeContribution<RunnerAgentCapabilityProviderContribution>[] {
        return this.getContributionsByType('agentCapabilityProvider')
    }

    getActions(): RegisteredRuntimeContribution<RunnerPluginActionContribution>[] {
        return this.getContributionsByType('action')
    }
}

export { redactText }

function validateContribution<T extends { id: string }>(type: RegisteredRuntimeContribution['type'], contribution: unknown): T {
    if (!contribution || typeof contribution !== 'object') {
        throw new Error(`${type} contribution must be an object.`)
    }
    const candidate = contribution as Record<string, unknown>
    if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) {
        throw new Error(`${type} contribution must have a non-empty id.`)
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate.id)) {
        throw new Error(`${type} contribution id must contain only alphanumeric characters, dots, underscores, or dashes.`)
    }
    if (candidate.priority !== undefined && (
        typeof candidate.priority !== 'number'
        || !Number.isInteger(candidate.priority)
        || candidate.priority < -1000
        || candidate.priority > 1000
    )) {
        throw new Error(`${type} contribution priority must be an integer between -1000 and 1000.`)
    }
    if (type === 'spawnOptionsProvider' && candidate.provide !== undefined && typeof candidate.provide !== 'function') {
        throw new Error('spawnOptionsProvider provide must be a function.')
    }
    if (type === 'environmentProvider' && candidate.provide !== undefined && typeof candidate.provide !== 'function') {
        throw new Error('environmentProvider provide must be a function.')
    }
    if (type === 'commandResolver' && candidate.resolve !== undefined && typeof candidate.resolve !== 'function') {
        throw new Error('commandResolver resolve must be a function.')
    }
    if (type === 'spawnHook') {
        for (const method of ['beforeSpawn', 'afterSpawn', 'onExit']) {
            if (candidate[method] !== undefined && typeof candidate[method] !== 'function') {
                throw new Error(`spawnHook ${method} must be a function.`)
            }
        }
    }
    if (type === 'agentAdapter') {
        const descriptor = AgentDescriptorSchema.safeParse(candidate.descriptor)
        if (!descriptor.success) {
            throw new Error('agentAdapter descriptor is invalid.')
        }
        if (descriptor.data.adapter.contributionId !== candidate.id) {
            throw new Error('agentAdapter id must match descriptor.adapter.contributionId.')
        }
        if (descriptor.data.adapter.runtime !== 'runner') {
            throw new Error('agentAdapter descriptor runtime must be runner.')
        }
        if (typeof candidate.createBackend !== 'function') {
            throw new Error('agentAdapter createBackend must be a function.')
        }
    }
    if (type === 'agentCapabilityProvider') {
        const agentId = AgentIdSchema.safeParse(candidate.agentId)
        if (!agentId.success) {
            throw new Error('agentCapabilityProvider agentId must be a valid agent id.')
        }
        if (candidate.provide !== undefined && typeof candidate.provide !== 'function') {
            throw new Error('agentCapabilityProvider provide must be a function.')
        }
        if (candidate.importHistory !== undefined && typeof candidate.importHistory !== 'function') {
            throw new Error('agentCapabilityProvider importHistory must be a function.')
        }
        if (candidate.provide === undefined && candidate.importHistory === undefined) {
            throw new Error('agentCapabilityProvider must define provide or importHistory.')
        }
    }
    if (type === 'action') {
        if (typeof candidate.kind !== 'string' || candidate.kind.trim().length === 0) {
            throw new Error('action kind must be a non-empty string.')
        }
        if (typeof candidate.run !== 'function') {
            throw new Error('action run must be a function.')
        }
    }
    return contribution as T
}
