import { z } from 'zod'
import { PluginWebContributionsSchema, WebLocalizedTextSchema } from './webDescriptors'

export const HAPI_PLUGIN_MANIFEST_FILE = 'hapi.plugin.json'
export const HAPI_PLUGIN_API_VERSION = '0.1'
export const HAPI_SUPPORTED_PLUGIN_API_VERSIONS = ['0.1'] as const
export type HapiSupportedPluginApiVersion = typeof HAPI_SUPPORTED_PLUGIN_API_VERSIONS[number]

export const PluginRuntimeNameSchema = z.enum(['hub', 'runner'])
export type PluginRuntimeName = z.infer<typeof PluginRuntimeNameSchema>

const PluginIdSchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must start with an alphanumeric character and contain only alphanumeric characters, dots, underscores, or dashes')

const SemverSchema = z.string()
    .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/, 'must be a semantic version')

const ContributionIdSchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must start with an alphanumeric character and contain only alphanumeric characters, dots, underscores, or dashes')

const ContributionSupportStatusSchema = z.enum(['supported', 'unsupported', 'stub'])

export const PluginLocalizedTextMetadataSchema = z.object({
    name: WebLocalizedTextSchema.optional(),
    description: WebLocalizedTextSchema.optional()
}).strict()
export type PluginLocalizedTextMetadata = z.infer<typeof PluginLocalizedTextMetadataSchema>

export const PluginDisplayMetadataSchema = PluginLocalizedTextMetadataSchema.extend({
    featureIntro: WebLocalizedTextSchema.optional()
}).strict()
export type PluginDisplayMetadata = z.infer<typeof PluginDisplayMetadataSchema>

const RuntimeEntrySchema = z.object({
    entry: z.string().min(1)
}).strict()

const HubRuntimeSchema = RuntimeEntrySchema
const RunnerRuntimeSchema = RuntimeEntrySchema

const RuntimeCompatibilitySchema = z.object({
    hapi: z.string().min(1).optional(),
    pluginApi: z.string().min(1).optional(),
    os: z.array(z.enum(['darwin', 'linux', 'win32'])).optional(),
    arch: z.array(z.string().min(1)).optional(),
    extensionPoints: z.array(z.string().min(1)).optional()
}).strict()

const CrossRuntimeCompatibilitySchema = z.object({
    samePluginVersionAcrossTargets: z.boolean().optional(),
    allowVersionSkew: z.enum(['none', 'patch', 'minor']).optional()
}).strict()

const PluginInstallHintsSchema = z.object({
    runnerPlacement: z.enum(['session-runner', 'selected-runners', 'compatible-runners', 'all-runners']).optional(),
    offlineRunnerPolicy: z.enum(['skip', 'fail']).optional(),
    minReadyRunnerCount: z.number().int().nonnegative().optional()
}).strict()

const HubNotificationChannelContributionSchema = z.object({
    id: ContributionIdSchema,
    displayName: z.string().min(1),
    display: PluginLocalizedTextMetadataSchema.optional()
}).strict()

export const HubMessageActionContributionSchema = z.object({
    id: ContributionIdSchema,
    displayName: z.string().min(1),
    description: z.string().optional(),
    display: PluginLocalizedTextMetadataSchema.optional()
}).strict()
export type HubMessageActionContributionDescriptor = z.infer<typeof HubMessageActionContributionSchema>

export const PluginCapabilityKindSchema = z.enum([
    'chat.composer.messageAction',
    'chat.contextProvider',
    'notification.channel',
    'runner.spawnExtension',
    'agent.adapter',
    'agent.capabilityProvider',
    'settings.panel',
    'integration.bridge'
])
export type PluginCapabilityKind = z.infer<typeof PluginCapabilityKindSchema>

export const PluginCapabilityPartTargetSchema = z.enum(['hub', 'session-runner', 'selected-runner', 'all-runners'])
export type PluginCapabilityPartTarget = z.infer<typeof PluginCapabilityPartTargetSchema>

export const PluginCapabilityPartContributionSchema = z.object({
    type: z.string().min(1).max(128),
    id: ContributionIdSchema
}).strict()
export type PluginCapabilityPartContribution = z.infer<typeof PluginCapabilityPartContributionSchema>

export const PluginCapabilityPartSchema = z.object({
    required: z.boolean().default(true),
    target: PluginCapabilityPartTargetSchema.optional(),
    contributions: z.array(PluginCapabilityPartContributionSchema).min(1)
}).strict()
export type PluginCapabilityPart = z.infer<typeof PluginCapabilityPartSchema>

export const PluginCapabilitySchema = z.object({
    id: ContributionIdSchema,
    kind: PluginCapabilityKindSchema,
    displayName: z.string().min(1).optional(),
    description: z.string().optional(),
    display: PluginLocalizedTextMetadataSchema.optional(),
    parts: z.object({
        web: PluginCapabilityPartSchema.optional(),
        hub: PluginCapabilityPartSchema.optional(),
        runner: PluginCapabilityPartSchema.optional()
    }).strict().refine((parts) => Boolean(parts.web || parts.hub || parts.runner), {
        message: 'capability requires at least one part'
    }),
    compatibility: z.object({
        minPluginVersion: z.string().min(1).optional(),
        sameVersionAcrossTargets: z.boolean().optional()
    }).strict().optional()
}).strict()
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>

const GenericContributionDescriptorSchema = z.object({
    id: ContributionIdSchema,
    displayName: z.string().min(1).optional(),
    description: z.string().optional(),
    display: PluginLocalizedTextMetadataSchema.optional(),
    supportStatus: ContributionSupportStatusSchema.optional(),
    limitations: z.array(z.string().min(1)).max(20).optional()
}).passthrough()

const RunnerContributionSchema = z.object({
    spawnOptionsProviders: z.array(GenericContributionDescriptorSchema).optional(),
    environmentProviders: z.array(GenericContributionDescriptorSchema).optional(),
    commandResolvers: z.array(GenericContributionDescriptorSchema).optional(),
    spawnHooks: z.array(GenericContributionDescriptorSchema).optional()
}).strict()

const AgentContributionSchema = z.object({
    adapters: z.array(GenericContributionDescriptorSchema).optional(),
    capabilityProviders: z.array(GenericContributionDescriptorSchema).optional()
}).strict()

const VoiceContributionSchema = z.object({
    providers: z.array(GenericContributionDescriptorSchema).optional()
}).strict()

const DeploymentContributionSchema = z.object({
    packs: z.array(GenericContributionDescriptorSchema).optional()
}).strict()

const IntegrationContributionSchema = z.object({
    protocolBridges: z.array(GenericContributionDescriptorSchema).optional()
}).strict()

const WebContributionSchema = PluginWebContributionsSchema

const PluginManifestLiteBaseSchema = z.object({
    id: PluginIdSchema,
    name: z.string().min(1),
    version: SemverSchema,
    pluginApiVersion: z.string().min(1),
    description: z.string().optional(),
    display: PluginDisplayMetadataSchema.optional(),
    capabilities: z.array(PluginCapabilitySchema).optional(),
    runtimes: z.object({
        hub: HubRuntimeSchema.optional(),
        runner: RunnerRuntimeSchema.optional()
    }).strict().optional(),
    contributions: z.object({
        hub: z.object({
            notificationChannels: z.array(HubNotificationChannelContributionSchema).optional(),
            messageActions: z.array(HubMessageActionContributionSchema).optional()
        }).strict().optional(),
        runner: RunnerContributionSchema.optional(),
        agent: AgentContributionSchema.optional(),
        voice: VoiceContributionSchema.optional(),
        deployment: DeploymentContributionSchema.optional(),
        integration: IntegrationContributionSchema.optional(),
        web: WebContributionSchema.optional()
    }).strict().optional(),
    config: z.object({
        schema: z.string().min(1).optional()
    }).strict().optional(),
    permissions: z.object({
        network: z.array(z.string().min(1)).optional(),
        secrets: z.array(z.string().min(1)).optional()
    }).strict().optional(),
    compatibility: z.object({
        hapi: z.string().min(1).optional(),
        pluginApi: z.string().min(1).optional(),
        os: z.array(z.enum(['darwin', 'linux', 'win32'])).optional(),
        arch: z.array(z.string().min(1)).optional(),
        hub: RuntimeCompatibilitySchema.optional(),
        runner: RuntimeCompatibilitySchema.optional(),
        crossRuntime: CrossRuntimeCompatibilitySchema.optional()
    }).strict().optional(),
    install: PluginInstallHintsSchema.optional()
}).strict()

export const RawPluginManifestLiteSchema = PluginManifestLiteBaseSchema

export const PluginManifestLiteSchema = PluginManifestLiteBaseSchema.extend({
    pluginApiVersion: z.enum(HAPI_SUPPORTED_PLUGIN_API_VERSIONS)
}).strict()

export type PluginManifestLite = z.infer<typeof PluginManifestLiteSchema>
export type RawPluginManifestLite = z.infer<typeof RawPluginManifestLiteSchema>

function hasDeclaredContributions(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    return Object.values(value as Record<string, unknown>).some((entry) => Array.isArray(entry) ? entry.length > 0 : Boolean(entry))
}

export function pluginManifestRequiresHubInstall(manifest: PluginManifestLite): boolean {
    const capabilities = manifest.capabilities ?? []
    const hasWeb = hasDeclaredContributions(manifest.contributions?.web)
        || capabilities.some((capability) => Boolean(capability.parts.web))
    return Boolean(manifest.runtimes?.hub)
        || hasDeclaredContributions(manifest.contributions?.hub)
        || hasDeclaredContributions(manifest.contributions?.voice)
        || hasDeclaredContributions(manifest.contributions?.deployment)
        || hasDeclaredContributions(manifest.contributions?.integration)
        || capabilities.some((capability) => Boolean(capability.parts.hub))
        || hasWeb
}

export function pluginManifestRequiresRunnerInstall(manifest: PluginManifestLite): boolean {
    const capabilities = manifest.capabilities ?? []
    return Boolean(manifest.runtimes?.runner)
        || hasDeclaredContributions(manifest.contributions?.runner)
        || hasDeclaredContributions(manifest.contributions?.agent)
        || capabilities.some((capability) => Boolean(capability.parts.runner))
}
