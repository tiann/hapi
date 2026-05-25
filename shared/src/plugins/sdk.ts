import type { AgentFlavor } from '../modes'
import type { AgentCapabilityProviderResult, AgentHistoryImportResult } from './agentCapabilities'
import type { AgentDescriptor } from './agentDescriptors'
import type { PluginNotificationEvent } from './notifications'
import type { AttachmentMetadata, Session } from '../types'
import type { PluginCapabilityKind } from './manifest'
import type {
    RunnerCommandResolverProposal,
    RunnerEnvironmentProposal,
    RunnerSpawnContext,
    RunnerSpawnOptionsContext,
    RunnerSpawnOptionsProviderProposal,
    RunnerSpawnHookProposal
} from './runnerExtensions'

export type { AgentFlavor } from '../modes'

/** Value or Promise value accepted from plugin runtime callbacks. */
export type MaybePromise<T> = T | Promise<T>

/** Cleanup handle returned by every plugin registration API. */
export type Disposable = {
    dispose(): void | Promise<void>
}

/** Logger scoped to one plugin. Declared secret values are redacted by the runtime. */
export type PluginLogger = {
    debug(message: string, ...args: unknown[]): void
    info(message: string, ...args: unknown[]): void
    warn(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
}

/** Read-only view of the plugin config for the active runtime/target scope. */
export type PluginConfigReader = {
    get<T = unknown>(key: string): T | undefined
    all(): Record<string, unknown>
}

/** Secret reader limited to names declared in hapi.plugin.json. */
export type PluginSecretReader = {
    get(name: string): string | undefined
}

/** Network client limited to permissions.network declarations. Basic SDK check only; not a sandbox. */
export type PluginNetwork = {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

/** Hub runtime notification channel contribution. */
export type PluginNotificationChannel = {
    send(event: PluginNotificationEvent): void | Promise<void>
    dispose?(): void | Promise<void>
}

/** Narrow session reference passed to plugin action handlers. */
export type PluginSessionRef = Pick<Session, 'id' | 'namespace' | 'active' | 'metadata'>

/** Attachment reference passed to plugin action handlers. */
export type PluginAttachmentRef = AttachmentMetadata

/** Internal core-owned message send plan returned by plugin action handlers. */
export type MessageSendPlan =
    | { type: 'immediate' }
    | {
        type: 'messageDelivery'
        delivery: {
            notBefore?: number
        }
        source: {
            pluginId: string
            capabilityId?: string
            actionId: string
        }
        payload?: unknown
    }

/** Hub message action input. Core owns auth/session lookup and passes a narrow DTO. */
export type HubMessageActionInput = {
    namespace: string
    session: PluginSessionRef
    text: string
    localId?: string
    attachments: PluginAttachmentRef[]
    payload: unknown
    capabilityId?: string
    actionId: string
}

/** Result returned by a Hub message action handler. */
export type HubMessageActionResult =
    | { ok: true; plan: MessageSendPlan }
    | { ok: false; code: string; message: string }

/** Hub message action contribution registered by a Hub plugin. */
export type HubMessageActionContribution = {
    id: string
    kind: Extract<PluginCapabilityKind, 'chat.composer.messageAction'>
    plan(input: HubMessageActionInput): MaybePromise<HubMessageActionResult>
    dispose?: () => void | Promise<void>
}

/** Runner generic plugin action input. */
export type RunnerPluginActionInput = {
    namespace: string
    machineId: string
    sessionId?: string
    cwd?: string
    payload: unknown
    capabilityId?: string
    actionId: string
}

/** Runner generic plugin action result. */
export type RunnerPluginActionResult =
    | { ok: true; result: unknown }
    | { ok: false; code: string; message: string }

/** Runner generic action contribution registered by a Runner plugin. */
export type RunnerPluginActionContribution = {
    id: string
    kind: PluginCapabilityKind
    run(input: RunnerPluginActionInput): MaybePromise<RunnerPluginActionResult>
    dispose?: () => void | Promise<void>
}

/** Context passed to a Hub runtime plugin activate(ctx) function. */
export type HubPluginContext = {
    pluginId: string
    logger: PluginLogger
    config: PluginConfigReader
    secrets: PluginSecretReader
    network: PluginNetwork
    notifications: {
        registerChannel(channel: PluginNotificationChannel): Disposable
    }
    messages: {
        registerAction(action: HubMessageActionContribution): Disposable
    }
}

/** Module shape for runtimes.hub.entry. */
export type HubPluginModule = {
    activate(ctx: HubPluginContext): void | Promise<void>
}

/** Spawn-options provider contribution registered by a Runner plugin. */
export type RunnerSpawnOptionsProviderContribution = {
    id: string
    priority?: number
    provide?: (context: RunnerSpawnOptionsContext) => MaybePromise<RunnerSpawnOptionsProviderProposal>
    dispose?: () => void | Promise<void>
}

/** Environment provider contribution registered by a Runner plugin. */
export type RunnerEnvironmentProviderContribution = {
    id: string
    priority?: number
    provide?: (context: RunnerSpawnContext) => MaybePromise<RunnerEnvironmentProposal>
    dispose?: () => void | Promise<void>
}

/** Command resolver contribution registered by a Runner plugin. */
export type RunnerCommandResolverContribution = {
    id: string
    priority?: number
    resolve?: (context: RunnerSpawnContext) => MaybePromise<RunnerCommandResolverProposal>
    dispose?: () => void | Promise<void>
}

/** Spawn hook contribution registered by a Runner plugin. */
export type RunnerSpawnHookContribution = {
    id: string
    priority?: number
    beforeSpawn?: (context: RunnerSpawnContext) => MaybePromise<RunnerSpawnHookProposal>
    afterSpawn?: (context: RunnerSpawnContext & { pid: number }) => MaybePromise<void>
    onExit?: (context: RunnerSpawnContext & { pid: number; exitCode: number | null; signal: string | null }) => MaybePromise<void>
    dispose?: () => void | Promise<void>
}

/** Agent adapter contribution registered by a Runner plugin. */
export type RunnerAgentAdapterContribution = {
    id: string
    priority?: number
    descriptor: AgentDescriptor
    createBackend: AgentBackendFactory
    dispose?: () => void | Promise<void>
}

/** Context passed to agent capability providers. */
export type RunnerAgentCapabilityProviderContext = {
    machineId: string
    agentId: string
}

/** Context passed to agent history importers. */
export type RunnerAgentHistoryImportContext = RunnerAgentCapabilityProviderContext & {
    nativeSessionId: string
}

/** Agent capability provider contribution registered by a Runner plugin. */
export type RunnerAgentCapabilityProviderContribution = {
    id: string
    agentId: string
    priority?: number
    provide?: (context: RunnerAgentCapabilityProviderContext) => MaybePromise<AgentCapabilityProviderResult>
    importHistory?: (context: RunnerAgentHistoryImportContext) => MaybePromise<AgentHistoryImportResult>
    dispose?: () => void | Promise<void>
}

/** Context passed to a Runner runtime plugin activate(ctx) function. */
export type RunnerPluginContext = {
    pluginId: string
    machineId: string
    logger: PluginLogger
    config: PluginConfigReader
    secrets: PluginSecretReader
    network: PluginNetwork
    runtime: {
        registerSpawnOptionsProvider(provider: RunnerSpawnOptionsProviderContribution): Disposable
        registerEnvironmentProvider(provider: RunnerEnvironmentProviderContribution): Disposable
        registerCommandResolver(resolver: RunnerCommandResolverContribution): Disposable
        registerSpawnHook(hook: RunnerSpawnHookContribution): Disposable
        registerAgentAdapter(adapter: RunnerAgentAdapterContribution): Disposable
        registerAgentCapabilityProvider(provider: RunnerAgentCapabilityProviderContribution): Disposable
    }
    actions: {
        register(action: RunnerPluginActionContribution): Disposable
    }
}

/** Module shape for runtimes.runner.entry. */
export type RunnerPluginModule = {
    activate(ctx: RunnerPluginContext): void | Promise<void>
}

/** MCP environment variable passed to agent-native session config. */
export type McpEnvVar = {
    name: string
    value: string
}

/** MCP stdio server passed to agent-native session config. */
export type McpServerStdio = {
    name: string
    command: string
    args: string[]
    env: McpEnvVar[]
}

/** Agent backend session config. */
export type AgentSessionConfig = {
    cwd: string
    mcpServers: McpServerStdio[]
}

/** User prompt content sent to a plugin-backed agent. */
export type PromptContent = {
    type: 'text'
    text: string
}

/** Plan item emitted by a plugin-backed agent. */
export type PlanItem = {
    content: string
    priority: 'high' | 'medium' | 'low'
    status: 'pending' | 'in_progress' | 'completed'
}

/** Normalized message emitted by a plugin-backed agent backend. */
export type AgentMessage =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string; id?: string; live?: boolean }
    | { type: 'tool_call'; id: string; name: string; input: unknown; status: 'pending' | 'in_progress' | 'completed' | 'failed' }
    | { type: 'tool_result'; id: string; output: unknown; status: 'completed' | 'failed' }
    | { type: 'plan'; items: PlanItem[] }
    | { type: 'turn_complete'; stopReason: string }
    | { type: 'error'; message: string }

/** User-selectable permission option emitted by a plugin-backed agent. */
export type PermissionOption = {
    optionId: string
    name: string
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
}

/** Permission request emitted by a plugin-backed agent. */
export type PermissionRequest = {
    id: string
    sessionId: string
    toolCallId: string
    title?: string
    kind?: string
    rawInput?: unknown
    rawOutput?: unknown
    options: PermissionOption[]
}

/** Permission response sent back to a plugin-backed agent. */
export type PermissionResponse =
    | { outcome: 'selected'; optionId: string }
    | { outcome: 'cancelled' }

/** Agent model descriptor returned by a plugin-backed agent backend. */
export type AgentSessionModelDescriptor = {
    modelId: string
    name?: string
}

/** Current model metadata returned by a plugin-backed agent backend. */
export type AgentSessionModelsMetadata = {
    availableModels: AgentSessionModelDescriptor[]
    currentModelId: string | null
}

/** Backend implementation returned by a Runner agent adapter contribution. */
export interface AgentBackend {
    initialize(): Promise<void>
    newSession(config: AgentSessionConfig): Promise<string>
    setModel?(sessionId: string, modelId: string, opts?: { flavor?: AgentFlavor }): Promise<void>
    getSessionModelsMetadata?(sessionId: string): AgentSessionModelsMetadata | undefined
    prompt(sessionId: string, content: PromptContent[], onUpdate: (msg: AgentMessage) => void): Promise<void>
    cancelPrompt(sessionId: string): Promise<void>
    respondToPermission(sessionId: string, request: PermissionRequest, response: PermissionResponse): Promise<void>
    onPermissionRequest(handler: (request: PermissionRequest) => void): void
    disconnect(): Promise<void>
}

/** Factory returned by a Runner agent adapter contribution. */
export type AgentBackendFactory = () => AgentBackend
