import { z } from 'zod'
import { PluginDiagnosticSchema, PluginStatusSchema } from './types'
import {
    PluginCapabilityKindSchema,
    PluginCapabilitySchema,
    PluginDisplayMetadataSchema,
    PluginLocalizedTextMetadataSchema,
    PluginManifestLiteSchema,
    PluginRuntimeNameSchema
} from './manifest'
import { PluginInstallMetadataSchema } from './state'
import { RunnerExtensionContributionSummarySchema } from './runnerExtensions'
import { PluginWebContributionsSchema, PluginWebContributionViewSchema } from './webDescriptors'

export const PluginAdminStatusSchema = PluginStatusSchema
export type PluginAdminStatus = z.infer<typeof PluginAdminStatusSchema>

export const PluginTargetMachineIdSchema = z.string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'machine id must contain only alphanumeric characters, dots, underscores, or dashes')
export type PluginTargetMachineId = z.infer<typeof PluginTargetMachineIdSchema>

export const PluginTargetScopeSchema = z.union([
    z.literal('hub'),
    z.literal('all-runners'),
    z.string().regex(/^runner:[A-Za-z0-9][A-Za-z0-9._-]*$/, 'scope must be hub, all-runners, or runner:<machineId>')
])
export type PluginTargetScope = z.infer<typeof PluginTargetScopeSchema>

export function runnerPluginTargetScope(machineId: string): PluginTargetScope {
    return `runner:${PluginTargetMachineIdSchema.parse(machineId)}` as PluginTargetScope
}

export function parseRunnerPluginTargetScope(scope: PluginTargetScope): string | null {
    return typeof scope === 'string' && scope.startsWith('runner:') ? scope.slice('runner:'.length) : null
}

export const PluginHostInfoSchema = z.object({
    runtime: PluginRuntimeNameSchema,
    hapiVersion: z.string().min(1),
    pluginApiVersion: z.string().min(1),
    supportedPluginApiVersions: z.array(z.string().min(1)).optional(),
    os: z.string().min(1),
    arch: z.string().min(1),
    supportedExtensionPoints: z.array(z.string().min(1)).default([])
}).strict()
export type PluginHostInfo = z.infer<typeof PluginHostInfoSchema>

const PluginConfigScopePluginIdSchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'plugin id must contain only alphanumeric characters, dots, underscores, or dashes')

const PluginConfigScopeAgentIdSchema = z.string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'agent id must contain only alphanumeric characters, dots, underscores, dashes, or colons')

export const PluginConfigScopeSchema = z.union([
    z.string().regex(/^hub:[A-Za-z0-9][A-Za-z0-9._-]*$/, 'scope must be hub:<pluginId>, runner:<machineId>:<pluginId>, or agent:<machineId>:<agentId>:<pluginId>'),
    z.string().regex(/^runner:[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/, 'scope must be hub:<pluginId>, runner:<machineId>:<pluginId>, or agent:<machineId>:<agentId>:<pluginId>'),
    z.string().regex(/^agent:[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/, 'scope must be hub:<pluginId>, runner:<machineId>:<pluginId>, or agent:<machineId>:<agentId>:<pluginId>')
])
export type PluginConfigScope = z.infer<typeof PluginConfigScopeSchema>

export function hubPluginConfigScope(pluginId: string): PluginConfigScope {
    return `hub:${PluginConfigScopePluginIdSchema.parse(pluginId)}` as PluginConfigScope
}

export function runnerPluginConfigScope(machineId: string, pluginId: string): PluginConfigScope {
    return `runner:${PluginTargetMachineIdSchema.parse(machineId)}:${PluginConfigScopePluginIdSchema.parse(pluginId)}` as PluginConfigScope
}

export function agentPluginConfigScope(machineId: string, agentId: string, pluginId: string): PluginConfigScope {
    return `agent:${PluginTargetMachineIdSchema.parse(machineId)}:${PluginConfigScopeAgentIdSchema.parse(agentId)}:${PluginConfigScopePluginIdSchema.parse(pluginId)}` as PluginConfigScope
}

export const PluginTargetSummarySchema = z.object({
    scope: PluginTargetScopeSchema,
    runtime: PluginRuntimeNameSchema,
    machineId: PluginTargetMachineIdSchema.optional(),
    displayName: z.string().optional(),
    active: z.boolean(),
    stale: z.boolean().optional(),
    updatedAt: z.number().optional(),
    hostInfo: PluginHostInfoSchema.optional(),
    error: z.string().optional()
}).strict()
export type PluginTargetSummary = z.infer<typeof PluginTargetSummarySchema>

export const PluginSecretStatusSchema = z.object({
    name: z.string().min(1),
    present: z.boolean(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    lastChecked: z.number().optional(),
    target: PluginTargetSummarySchema.optional(),
    configScope: PluginConfigScopeSchema.optional()
}).strict()
export type PluginSecretStatus = z.infer<typeof PluginSecretStatusSchema>

export const PluginRuntimeSummarySchema = z.object({
    hub: z.object({
        entry: z.string().min(1),
        active: z.boolean()
    }).strict().optional(),
    runner: z.object({
        entry: z.string().min(1),
        active: z.boolean()
    }).strict().optional()
}).strict()
export type PluginRuntimeSummary = z.infer<typeof PluginRuntimeSummarySchema>

export const PluginDiagnosticViewSchema = PluginDiagnosticSchema.extend({
    pluginId: z.string().optional(),
    target: PluginTargetSummarySchema.optional(),
    configScope: PluginConfigScopeSchema.optional()
}).strict()
export type PluginDiagnosticView = z.infer<typeof PluginDiagnosticViewSchema>

export const PluginRuntimeContributionStateSchema = z.object({
    pluginId: z.string().min(1),
    target: PluginTargetSummarySchema,
    runtime: PluginRuntimeNameSchema,
    contributionType: z.string().min(1),
    contributionId: z.string().min(1),
    declared: z.boolean(),
    registered: z.boolean(),
    active: z.boolean(),
    diagnostics: z.array(PluginDiagnosticViewSchema).default([])
}).strict()
export type PluginRuntimeContributionState = z.infer<typeof PluginRuntimeContributionStateSchema>

export const PluginCapabilityStatusSchema = z.enum([
    'ready',
    'partial',
    'disabled',
    'missing-target',
    'offline',
    'failed',
    'incompatible'
])
export type PluginCapabilityStatus = z.infer<typeof PluginCapabilityStatusSchema>

export const PluginCapabilityPartStatusSchema = z.object({
    status: PluginCapabilityStatusSchema,
    target: PluginTargetSummarySchema.optional(),
    required: z.boolean().optional(),
    declared: z.boolean().optional(),
    registered: z.boolean().optional(),
    active: z.boolean().optional(),
    diagnostics: z.array(PluginDiagnosticViewSchema).default([])
}).strict()
export type PluginCapabilityPartStatus = z.infer<typeof PluginCapabilityPartStatusSchema>

export const PluginCapabilitySourceViewSchema = z.object({
    pluginId: z.string().min(1),
    pluginName: z.string().optional(),
    pluginVersion: z.string().optional(),
    target: PluginTargetSummarySchema,
    capabilities: z.array(PluginCapabilitySchema).default([])
}).strict()
export type PluginCapabilitySourceView = z.infer<typeof PluginCapabilitySourceViewSchema>

export const PluginCapabilityViewSchema = z.object({
    pluginId: z.string().min(1),
    pluginName: z.string().optional(),
    pluginVersion: z.string().optional(),
    capabilityId: z.string().min(1),
    kind: PluginCapabilityKindSchema,
    displayName: z.string().optional(),
    description: z.string().optional(),
    display: PluginLocalizedTextMetadataSchema.optional(),
    status: PluginCapabilityStatusSchema,
    target: PluginTargetSummarySchema.optional(),
    parts: z.object({
        web: PluginCapabilityPartStatusSchema.optional(),
        hub: PluginCapabilityPartStatusSchema.optional(),
        runner: PluginCapabilityPartStatusSchema.optional()
    }).strict(),
    web: PluginWebContributionsSchema.optional(),
    diagnostics: z.array(PluginDiagnosticViewSchema).default([])
}).strict()
export type PluginCapabilityView = z.infer<typeof PluginCapabilityViewSchema>

export const PluginScopedConfigMetadataSchema = z.object({
    scope: PluginConfigScopeSchema,
    pluginId: z.string().min(1),
    runtime: PluginRuntimeNameSchema,
    target: PluginTargetSummarySchema,
    config: z.record(z.string(), z.unknown()).default({}),
    updatedAt: z.number().optional(),
    source: z.enum(['scoped', 'legacy-default', 'empty']).optional()
}).strict()
export type PluginScopedConfigMetadata = z.infer<typeof PluginScopedConfigMetadataSchema>

export const PluginListItemSchema = z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    display: PluginDisplayMetadataSchema.optional(),
    source: z.enum(['env', 'user-home', 'bundled']),
    status: PluginAdminStatusSchema,
    enabled: z.boolean(),
    active: z.boolean(),
    rootPath: z.string().min(1),
    manifestPath: z.string().min(1),
    runtimes: PluginRuntimeSummarySchema,
    diagnostics: z.array(PluginDiagnosticViewSchema),
    target: PluginTargetSummarySchema.optional(),
    configScope: PluginConfigScopeSchema.optional(),
    updatedAt: z.number().optional(),
    install: PluginInstallMetadataSchema.optional()
}).strict()
export type PluginListItem = z.infer<typeof PluginListItemSchema>

export const PluginDetailSchema = PluginListItemSchema.extend({
    manifest: PluginManifestLiteSchema.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    configMetadata: PluginScopedConfigMetadataSchema.optional(),
    permissions: z.object({
        network: z.array(z.string()),
        secrets: z.array(PluginSecretStatusSchema)
    }).strict(),
    contributions: z.object({
        notificationChannels: z.array(z.object({
            id: z.string().min(1),
            displayName: z.string().min(1),
            display: PluginLocalizedTextMetadataSchema.optional()
        }).strict()),
        messageActions: z.array(z.object({
            id: z.string().min(1),
            displayName: z.string().min(1),
            description: z.string().optional(),
            display: PluginLocalizedTextMetadataSchema.optional()
        }).strict()).optional(),
        runner: z.object({
            spawnOptionsProviders: z.array(z.unknown()).optional(),
            environmentProviders: z.array(z.unknown()).optional(),
            commandResolvers: z.array(z.unknown()).optional(),
            spawnHooks: z.array(z.unknown()).optional()
        }).strict().optional(),
        agent: z.object({
            adapters: z.array(z.unknown()).optional(),
            capabilityProviders: z.array(z.unknown()).optional()
        }).strict().optional(),
        voice: z.object({
            providers: z.array(z.unknown()).optional()
        }).strict().optional(),
        deployment: z.object({
            packs: z.array(z.unknown()).optional()
        }).strict().optional(),
        integration: z.object({
            protocolBridges: z.array(z.unknown()).optional()
        }).strict().optional(),
        web: PluginWebContributionsSchema.optional()
    }).strict(),
    runtimeEntryPaths: z.array(z.object({
        runtime: PluginRuntimeNameSchema,
        entry: z.string().min(1),
        resolvedPath: z.string().min(1),
        realPath: z.string().min(1)
    }).strict())
}).strict()
export type PluginDetail = z.infer<typeof PluginDetailSchema>

export const PluginTargetInventorySchema = z.object({
    target: PluginTargetSummarySchema,
    plugins: z.array(PluginListItemSchema),
    webContributions: z.array(PluginWebContributionViewSchema).optional(),
    capabilitySources: z.array(PluginCapabilitySourceViewSchema).optional(),
    contributionStates: z.array(PluginRuntimeContributionStateSchema).optional(),
    capabilities: z.array(PluginCapabilityViewSchema).optional(),
    error: z.string().optional()
}).strict()
export type PluginTargetInventory = z.infer<typeof PluginTargetInventorySchema>

export const RunnerPluginInventorySchema = z.object({
    machineId: PluginTargetMachineIdSchema,
    updatedAt: z.number(),
    hostInfo: PluginHostInfoSchema.optional(),
    plugins: z.array(PluginListItemSchema),
    diagnostics: z.array(PluginDiagnosticViewSchema).default([]),
    extensions: z.object({
        spawnOptionsProviders: z.array(RunnerExtensionContributionSummarySchema).default([]),
        environmentProviders: z.array(RunnerExtensionContributionSummarySchema).default([]),
        commandResolvers: z.array(RunnerExtensionContributionSummarySchema).default([]),
        spawnHooks: z.array(RunnerExtensionContributionSummarySchema).default([])
    }).strict().optional(),
    webContributions: z.array(PluginWebContributionViewSchema).optional(),
    capabilitySources: z.array(PluginCapabilitySourceViewSchema).optional(),
    contributionStates: z.array(PluginRuntimeContributionStateSchema).optional(),
    capabilities: z.array(PluginCapabilityViewSchema).optional()
}).strict()
export type RunnerPluginInventory = z.infer<typeof RunnerPluginInventorySchema>

export const PluginListResponseSchema = z.object({
    plugins: z.array(PluginListItemSchema),
    targets: z.array(PluginTargetInventorySchema).optional()
}).strict()
export type PluginListResponse = z.infer<typeof PluginListResponseSchema>

export const PluginDetailResponseSchema = z.object({
    plugin: PluginDetailSchema
}).strict()
export type PluginDetailResponse = z.infer<typeof PluginDetailResponseSchema>

export const PluginDiagnosticsResponseSchema = z.object({
    diagnostics: z.array(PluginDiagnosticViewSchema)
}).strict()
export type PluginDiagnosticsResponse = z.infer<typeof PluginDiagnosticsResponseSchema>

export const PluginCapabilitiesResponseSchema = z.object({
    capabilities: z.array(PluginCapabilityViewSchema)
}).strict()
export type PluginCapabilitiesResponse = z.infer<typeof PluginCapabilitiesResponseSchema>

export const PluginNotificationFilterOptionSchema = z.object({
    value: z.string().min(1),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    count: z.number().int().nonnegative().optional(),
    lastSeenAt: z.number().int().nonnegative().optional()
}).strict()
export type PluginNotificationFilterOption = z.infer<typeof PluginNotificationFilterOptionSchema>

export const PluginNotificationFilterOptionsResponseSchema = z.object({
    namespaces: z.array(PluginNotificationFilterOptionSchema).default([]),
    agents: z.array(PluginNotificationFilterOptionSchema).default([]),
    workspaces: z.array(PluginNotificationFilterOptionSchema).default([])
}).strict()
export type PluginNotificationFilterOptionsResponse = z.infer<typeof PluginNotificationFilterOptionsResponseSchema>

export const PluginNotificationTestResponseSchema = z.object({
    ok: z.literal(true),
    pluginId: z.string().min(1).max(128),
    channels: z.number().int().nonnegative(),
    message: z.string().min(1).optional()
}).strict()
export type PluginNotificationTestResponse = z.infer<typeof PluginNotificationTestResponseSchema>

export const RunnerPluginActionInvokeRequestSchema = z.object({
    pluginId: z.string().min(1).max(128),
    capabilityId: z.string().min(1).max(128).optional(),
    actionId: z.string().min(1).max(128),
    namespace: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    payload: z.unknown().optional()
}).strict()
export type RunnerPluginActionInvokeRequest = z.infer<typeof RunnerPluginActionInvokeRequestSchema>

export const RunnerPluginActionInvokeResponseSchema = z.union([
    z.object({
        ok: z.literal(true),
        result: z.unknown()
    }).strict(),
    z.object({
        ok: z.literal(false),
        code: z.string().min(1),
        message: z.string().min(1)
    }).strict()
])
export type RunnerPluginActionInvokeResponse = z.infer<typeof RunnerPluginActionInvokeResponseSchema>

export const PluginReloadActionSchema = z.enum([
    'activated',
    'deactivated',
    'reloaded',
    'unchanged',
    'failed',
    'kept-previous'
])
export type PluginReloadAction = z.infer<typeof PluginReloadActionSchema>

export const PluginReloadItemSchema = z.object({
    id: z.string().min(1),
    action: PluginReloadActionSchema,
    status: PluginAdminStatusSchema,
    message: z.string().optional(),
    diagnostics: z.array(PluginDiagnosticViewSchema).default([])
}).strict()
export type PluginReloadItem = z.infer<typeof PluginReloadItemSchema>

export const PluginTargetActionResultSchema = z.object({
    target: PluginTargetSummarySchema,
    ok: z.boolean(),
    error: z.string().optional(),
    results: z.array(PluginReloadItemSchema).optional(),
    plugins: z.array(PluginListItemSchema).optional()
}).strict()
export type PluginTargetActionResult = z.infer<typeof PluginTargetActionResultSchema>

export const PluginReloadResultSchema = z.object({
    ok: z.boolean(),
    targetId: z.string().optional(),
    target: PluginTargetSummarySchema.optional(),
    targetResults: z.array(PluginTargetActionResultSchema).optional(),
    results: z.array(PluginReloadItemSchema),
    plugins: z.array(PluginListItemSchema)
}).strict()
export type PluginReloadResult = z.infer<typeof PluginReloadResultSchema>

export const PluginInstallActionSchema = z.enum(['installed', 'overwritten', 'unchanged'])
export type PluginInstallAction = z.infer<typeof PluginInstallActionSchema>

export const PluginInstallLocalRequestSchema = z.object({
    sourcePath: z.string().min(1),
    enable: z.boolean().optional(),
    reload: z.boolean().optional(),
    overwrite: z.boolean().optional()
}).strict()
export type PluginInstallLocalRequest = z.infer<typeof PluginInstallLocalRequestSchema>

export const PluginPackageFormatSchema = z.enum(['tgz', 'zip'])
export type PluginPackageFormat = z.infer<typeof PluginPackageFormatSchema>

export const PluginPackageFileSchema = z.object({
    path: z.string().min(1),
    size: z.number().int().nonnegative().optional(),
    sha256: z.string().min(1).optional()
}).strict()
export type PluginPackageFile = z.infer<typeof PluginPackageFileSchema>

export const PluginPackageManifestSchema = z.object({
    formatVersion: z.literal('hapi-plugin-package/v1'),
    manifest: PluginManifestLiteSchema,
    files: z.array(PluginPackageFileSchema).default([]),
    checksum: z.string().min(1),
    signature: z.object({
        algorithm: z.string().min(1),
        value: z.string().min(1)
    }).strict().optional()
}).strict()
export type PluginPackageManifest = z.infer<typeof PluginPackageManifestSchema>

export const PluginInstallPackageRequestSchema = z.object({
    filename: z.string().min(1),
    contentBase64: z.string().min(1),
    checksum: z.string().min(1),
    format: PluginPackageFormatSchema.optional(),
    manifest: PluginPackageManifestSchema.optional(),
    installSource: z.object({
        type: z.literal('marketplace'),
        sourceUrl: z.string().min(1),
        pluginId: z.string().min(1),
        repo: z.string().min(1),
        version: z.string().min(1),
        distribution: z.enum(['package', 'hapi-source']).optional(),
        assetUrl: z.string().min(1).optional(),
        sourcePath: z.string().min(1).optional()
    }).strict().optional(),
    enable: z.boolean().optional(),
    reload: z.boolean().optional(),
    overwrite: z.boolean().optional()
}).strict()
export type PluginInstallPackageRequest = z.infer<typeof PluginInstallPackageRequestSchema>

export const PluginInstallPositionSchema = z.enum(['web', 'hub', 'runner'])
export type PluginInstallPosition = z.infer<typeof PluginInstallPositionSchema>

export const PluginInstallRunnerSelectionSchema = z.object({
    mode: z.enum(['compatible', 'all', 'selected']).default('compatible'),
    machineIds: z.array(PluginTargetMachineIdSchema).optional()
}).strict()
export type PluginInstallRunnerSelection = z.infer<typeof PluginInstallRunnerSelectionSchema>

export const PluginInstallPlanRequestSchema = PluginInstallPackageRequestSchema.extend({
    runnerSelection: PluginInstallRunnerSelectionSchema.optional(),
    dryRun: z.boolean().optional()
}).strict()
export type PluginInstallPlanRequest = z.infer<typeof PluginInstallPlanRequestSchema>

export const PluginInstallPlanTargetActionSchema = z.enum(['install', 'overwrite', 'unchanged', 'skip', 'block'])
export type PluginInstallPlanTargetAction = z.infer<typeof PluginInstallPlanTargetActionSchema>

export const PluginInstallPlanTargetStatusSchema = z.enum(['compatible', 'incompatible', 'offline', 'conflict'])
export type PluginInstallPlanTargetStatus = z.infer<typeof PluginInstallPlanTargetStatusSchema>

export const PluginInstallPlanTargetSchema = z.object({
    target: PluginTargetSummarySchema,
    runtime: PluginRuntimeNameSchema,
    required: z.boolean(),
    compatible: z.boolean(),
    status: PluginInstallPlanTargetStatusSchema,
    action: PluginInstallPlanTargetActionSchema,
    reason: z.string().optional(),
    existingVersion: z.string().optional()
}).strict()
export type PluginInstallPlanTarget = z.infer<typeof PluginInstallPlanTargetSchema>

export const PluginInstallPlanResponseSchema = z.object({
    planId: z.string().min(1),
    createdAt: z.number(),
    expiresAt: z.number().optional(),
    plugin: z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        version: z.string().min(1),
        description: z.string().optional(),
        display: PluginDisplayMetadataSchema.optional()
    }).strict(),
    source: z.object({
        type: z.enum(['uploaded-package', 'marketplace-package', 'marketplace-source']),
        filename: z.string().min(1),
        checksum: z.string().min(1),
        format: PluginPackageFormatSchema.optional(),
        assetUrl: z.string().min(1).optional(),
        sourcePath: z.string().min(1).optional()
    }).strict(),
    positions: z.array(PluginInstallPositionSchema).min(1),
    targets: z.array(PluginInstallPlanTargetSchema),
    warnings: z.array(z.string()).default([]),
    blockingErrors: z.array(z.string()).default([])
}).strict()
export type PluginInstallPlanResponse = z.infer<typeof PluginInstallPlanResponseSchema>

export const PluginInstallResultSchema = z.object({
    ok: z.boolean(),
    action: PluginInstallActionSchema,
    plugin: PluginListItemSchema.optional(),
    pluginId: z.string().min(1).optional(),
    sourcePath: z.string().min(1).optional(),
    targetPath: z.string().min(1).optional(),
    target: PluginTargetSummarySchema.optional(),
    targetResults: z.array(z.object({
        target: PluginTargetSummarySchema,
        ok: z.boolean(),
        error: z.string().optional(),
        action: PluginInstallActionSchema.optional(),
        pluginId: z.string().min(1).optional(),
        targetPath: z.string().min(1).optional(),
        diagnostics: z.array(PluginDiagnosticViewSchema).default([]),
        plugins: z.array(PluginListItemSchema).optional()
    }).strict()).optional(),
    diagnostics: z.array(PluginDiagnosticViewSchema).default([]),
    reload: PluginReloadResultSchema.optional(),
    plugins: z.array(PluginListItemSchema)
}).strict()
export type PluginInstallResult = z.infer<typeof PluginInstallResultSchema>

export const PluginDeleteResultSchema = z.object({
    ok: z.boolean(),
    pluginId: z.string().min(1),
    rootPath: z.string().min(1).optional(),
    deleted: z.boolean(),
    target: PluginTargetSummarySchema.optional(),
    targetResults: z.array(z.object({
        target: PluginTargetSummarySchema,
        ok: z.boolean(),
        error: z.string().optional(),
        pluginId: z.string().min(1).optional(),
        rootPath: z.string().min(1).optional(),
        deleted: z.boolean().optional(),
        plugins: z.array(PluginListItemSchema).optional()
    }).strict()).optional(),
    reload: PluginReloadResultSchema.optional(),
    plugins: z.array(PluginListItemSchema)
}).strict()
export type PluginDeleteResult = z.infer<typeof PluginDeleteResultSchema>

export const PluginLocalDirectoryListRequestSchema = z.object({
    path: z.string().optional()
}).strict()
export type PluginLocalDirectoryListRequest = z.infer<typeof PluginLocalDirectoryListRequestSchema>

export const PluginLocalDirectoryEntrySchema = z.object({
    name: z.string().min(1),
    type: z.enum(['file', 'directory', 'other']),
    size: z.number().optional(),
    modified: z.number().optional(),
    hasPluginManifest: z.boolean().optional()
}).strict()
export type PluginLocalDirectoryEntry = z.infer<typeof PluginLocalDirectoryEntrySchema>

export const PluginLocalDirectoryListResponseSchema = z.object({
    success: z.boolean(),
    path: z.string().optional(),
    parentPath: z.string().optional(),
    hasPluginManifest: z.boolean().optional(),
    entries: z.array(PluginLocalDirectoryEntrySchema).optional(),
    error: z.string().optional()
}).strict()
export type PluginLocalDirectoryListResponse = z.infer<typeof PluginLocalDirectoryListResponseSchema>

export const PluginEnableRequestSchema = z.object({
    config: z.record(z.string(), z.unknown()).optional(),
    reload: z.boolean().optional()
}).strict()
export type PluginEnableRequest = z.infer<typeof PluginEnableRequestSchema>

export const PluginDisableRequestSchema = z.object({
    reload: z.boolean().optional()
}).strict()
export type PluginDisableRequest = z.infer<typeof PluginDisableRequestSchema>

export const PluginConfigUpdateRequestSchema = z.object({
    config: z.record(z.string(), z.unknown())
}).strict()
export type PluginConfigUpdateRequest = z.infer<typeof PluginConfigUpdateRequestSchema>

export const RunnerPluginsListRequestSchema = z.object({}).strict()
export type RunnerPluginsListRequest = z.infer<typeof RunnerPluginsListRequestSchema>

export const RunnerPluginsInspectRequestSchema = z.object({
    pluginId: z.string().min(1)
}).strict()
export type RunnerPluginsInspectRequest = z.infer<typeof RunnerPluginsInspectRequestSchema>

export const RunnerPluginsEnableRequestSchema = z.object({
    pluginId: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
    reload: z.boolean().optional()
}).strict()
export type RunnerPluginsEnableRequest = z.infer<typeof RunnerPluginsEnableRequestSchema>

export const RunnerPluginsDisableRequestSchema = z.object({
    pluginId: z.string().min(1),
    reload: z.boolean().optional()
}).strict()
export type RunnerPluginsDisableRequest = z.infer<typeof RunnerPluginsDisableRequestSchema>

export const RunnerPluginsConfigUpdateRequestSchema = z.object({
    pluginId: z.string().min(1),
    config: z.record(z.string(), z.unknown())
}).strict()
export type RunnerPluginsConfigUpdateRequest = z.infer<typeof RunnerPluginsConfigUpdateRequestSchema>

export const RunnerPluginsReloadRequestSchema = z.object({
    pluginId: z.string().min(1).optional()
}).strict()
export type RunnerPluginsReloadRequest = z.infer<typeof RunnerPluginsReloadRequestSchema>

export const RunnerPluginsInstallPrepareRequestSchema = z.object({
    pluginId: z.string().min(1).optional(),
    manifest: PluginManifestLiteSchema.optional()
}).strict()
export type RunnerPluginsInstallPrepareRequest = z.infer<typeof RunnerPluginsInstallPrepareRequestSchema>

export const RunnerPluginsInstallCommitRequestSchema = z.object({
    token: z.string().min(1).optional()
}).strict()
export type RunnerPluginsInstallCommitRequest = z.infer<typeof RunnerPluginsInstallCommitRequestSchema>

export const RunnerPluginsLocalDirectoryListRequestSchema = PluginLocalDirectoryListRequestSchema
export type RunnerPluginsLocalDirectoryListRequest = z.infer<typeof RunnerPluginsLocalDirectoryListRequestSchema>

export const RunnerPluginsInstallLocalRequestSchema = PluginInstallLocalRequestSchema
export type RunnerPluginsInstallLocalRequest = z.infer<typeof RunnerPluginsInstallLocalRequestSchema>

export const RunnerPluginsInstallPackageRequestSchema = PluginInstallPackageRequestSchema
export type RunnerPluginsInstallPackageRequest = z.infer<typeof RunnerPluginsInstallPackageRequestSchema>

export const RunnerPluginUnsupportedInstallResultSchema = z.object({
    ok: z.literal(false),
    code: z.literal('unsupported-runtime'),
    message: z.string()
}).strict()
export type RunnerPluginUnsupportedInstallResult = z.infer<typeof RunnerPluginUnsupportedInstallResultSchema>

export const RunnerPluginsDeleteRequestSchema = z.object({
    pluginId: z.string().min(1),
    reload: z.boolean().optional()
}).strict()
export type RunnerPluginsDeleteRequest = z.infer<typeof RunnerPluginsDeleteRequestSchema>
