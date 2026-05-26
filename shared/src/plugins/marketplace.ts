import { z } from 'zod'
import { PluginCapabilityKindSchema, PluginDisplayMetadataSchema, PluginManifestLiteSchema, PluginRuntimeNameSchema } from './manifest'
import { PluginInstallPlanResponseSchema, PluginInstallRunnerSelectionSchema } from './admin'

const Sha256ChecksumSchema = z.string()
    .regex(/^sha256:[a-f0-9]{64}$/i, 'checksum must be sha256:<64 hex chars>')

const GitHubRepoSlugSchema = z.string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repo must be owner/name')

const MarketplaceSemverSchema = z.string()
    .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/, 'must be a semantic version')

const ExternalHttpUrlSchema = z.string().url().refine((value) => {
    try {
        const protocol = new URL(value).protocol
        return protocol === 'https:' || protocol === 'http:'
    } catch {
        return false
    }
}, 'URL must use http or https')

export const PluginMarketplaceReleaseManifestSchema = z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1),
    version: MarketplaceSemverSchema,
    pluginApiVersion: z.string().min(1),
    display: PluginDisplayMetadataSchema.optional(),
    permissions: z.object({
        network: z.array(z.string().min(1)).optional(),
        secrets: z.array(z.string().min(1)).optional()
    }).strict().optional()
}).passthrough()
export type PluginMarketplaceReleaseManifest = z.infer<typeof PluginMarketplaceReleaseManifestSchema>

export const PluginMarketplaceCategorySchema = z.enum([
    'notification',
    'runner',
    'agent',
    'chat',
    'integration',
    'theme',
    'utility'
])
export type PluginMarketplaceCategory = z.infer<typeof PluginMarketplaceCategorySchema>

export const PluginMarketplacePackageSchema = z.object({
    filename: z.string().min(1),
    url: z.string().url(),
    format: z.enum(['tgz', 'zip']),
    checksum: Sha256ChecksumSchema,
    size: z.number().int().nonnegative().optional(),
    packageManifestUrl: z.string().url().optional()
}).strict()
export type PluginMarketplacePackage = z.infer<typeof PluginMarketplacePackageSchema>

export const PluginMarketplaceSourceSchema = z.object({
    type: z.literal('hapi-source'),
    path: z.string().min(1),
    treeChecksum: Sha256ChecksumSchema.optional(),
    embedded: z.boolean().optional()
}).strict()
export type PluginMarketplaceSource = z.infer<typeof PluginMarketplaceSourceSchema>

export const PluginMarketplaceReleaseSchema = z.object({
    version: MarketplaceSemverSchema,
    tag: z.string().min(1),
    releasedAt: z.string().datetime({ offset: true }).optional(),
    manifest: PluginMarketplaceReleaseManifestSchema,
    package: PluginMarketplacePackageSchema.optional(),
    source: PluginMarketplaceSourceSchema.optional(),
    compatibility: z.record(z.string(), z.unknown()).optional(),
    yanked: z.object({
        reason: z.string().min(1),
        replacedBy: z.string().min(1).optional()
    }).strict().optional()
}).strict().superRefine((release, ctx) => {
    if (release.version !== release.manifest.version) {
        ctx.addIssue({
            code: 'custom',
            message: 'release version must match manifest.version',
            path: ['version']
        })
    }
    if (!release.package && !release.source) {
        ctx.addIssue({
            code: 'custom',
            message: 'release must provide package or source distribution',
            path: ['package']
        })
    }
    if (release.package && release.source) {
        ctx.addIssue({
            code: 'custom',
            message: 'release must not provide both package and source distribution',
            path: ['source']
        })
    }
})
export type PluginMarketplaceRelease = z.infer<typeof PluginMarketplaceReleaseSchema>

export const PluginMarketplaceEntrySchema = z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1),
    display: PluginDisplayMetadataSchema.optional(),
    description: z.string().optional(),
    repo: GitHubRepoSlugSchema,
    homepage: ExternalHttpUrlSchema.optional(),
    author: z.object({
        name: z.string().min(1),
        url: ExternalHttpUrlSchema.optional()
    }).strict().optional(),
    license: z.string().min(1).optional(),
    categories: z.array(PluginMarketplaceCategorySchema).max(20).optional(),
    keywords: z.array(z.string().min(1)).max(30).optional(),
    runtimes: z.array(PluginRuntimeNameSchema).optional(),
    capabilities: z.array(z.object({
        kind: PluginCapabilityKindSchema,
        label: z.string().min(1).optional()
    }).strict()).optional(),
    releases: z.array(PluginMarketplaceReleaseSchema).min(1)
}).strict().superRefine((entry, ctx) => {
    const seenReleaseVersions = new Set<string>()
    for (const [index, release] of entry.releases.entries()) {
        if (release.manifest.id !== entry.id) {
            ctx.addIssue({
                code: 'custom',
                message: 'release manifest.id must match marketplace entry id',
                path: ['releases', index, 'manifest', 'id']
            })
        }
        if (seenReleaseVersions.has(release.version)) {
            ctx.addIssue({
                code: 'custom',
                message: `duplicate marketplace release version ${release.version}`,
                path: ['releases', index, 'version']
            })
        }
        seenReleaseVersions.add(release.version)
    }
})
export type PluginMarketplaceEntry = z.infer<typeof PluginMarketplaceEntrySchema>

export const PluginMarketplaceCatalogSchema = z.object({
    schemaVersion: z.literal('hapi-plugin-marketplace/v1'),
    updatedAt: z.string().datetime({ offset: true }),
    plugins: z.array(PluginMarketplaceEntrySchema).default([])
}).strict().superRefine((catalog, ctx) => {
    const seen = new Set<string>()
    for (const [index, plugin] of catalog.plugins.entries()) {
        if (seen.has(plugin.id)) {
            ctx.addIssue({
                code: 'custom',
                message: `duplicate marketplace plugin id ${plugin.id}`,
                path: ['plugins', index, 'id']
            })
        }
        seen.add(plugin.id)
    }
})
export type PluginMarketplaceCatalog = z.infer<typeof PluginMarketplaceCatalogSchema>

export const PluginMarketplaceInstallRequestSchema = z.object({
    version: z.string().min(1).optional(),
    runnerSelection: PluginInstallRunnerSelectionSchema.optional(),
    enable: z.boolean().optional(),
    reload: z.boolean().optional(),
    overwrite: z.boolean().optional()
}).strict()
export type PluginMarketplaceInstallRequest = z.infer<typeof PluginMarketplaceInstallRequestSchema>

export const PluginMarketplaceEntryViewSchema = PluginMarketplaceEntrySchema.safeExtend({
    latestCompatibleVersion: z.string().min(1).optional(),
    installed: z.object({
        version: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        updateAvailable: z.boolean().optional(),
        updateVersion: z.string().min(1).optional(),
        yanked: z.boolean().optional()
    }).strict().optional()
}).strict()
export type PluginMarketplaceEntryView = z.infer<typeof PluginMarketplaceEntryViewSchema>

export const PluginMarketplaceListResponseSchema = z.object({
    sourceUrl: z.string().min(1),
    fetchedAt: z.number(),
    entries: z.array(PluginMarketplaceEntryViewSchema),
    stale: z.boolean().optional(),
    error: z.string().optional()
}).strict()
export type PluginMarketplaceListResponse = z.infer<typeof PluginMarketplaceListResponseSchema>

export const PluginMarketplaceDetailResponseSchema = z.object({
    sourceUrl: z.string().min(1),
    fetchedAt: z.number(),
    entry: PluginMarketplaceEntryViewSchema
}).strict()
export type PluginMarketplaceDetailResponse = z.infer<typeof PluginMarketplaceDetailResponseSchema>

export const PluginMarketplaceInstallPlanResponseSchema = z.object({
    marketplace: z.object({
        sourceUrl: z.string().min(1),
        pluginId: z.string().min(1),
        repo: z.string().min(1),
        version: z.string().min(1),
        distribution: z.enum(['package', 'hapi-source']),
        assetUrl: z.string().min(1).optional(),
        sourcePath: z.string().min(1).optional(),
        checksum: z.string().min(1)
    }).strict(),
    plan: PluginInstallPlanResponseSchema
}).strict()
export type PluginMarketplaceInstallPlanResponse = z.infer<typeof PluginMarketplaceInstallPlanResponseSchema>
