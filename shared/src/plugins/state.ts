import { z } from 'zod'

export const PluginInstallMetadataSchema = z.object({
    sourceType: z.enum(['env', 'user-home', 'bundled', 'hub-local-path', 'runner-local-path', 'uploaded-package', 'marketplace']),
    sourcePath: z.string().min(1).optional(),
    checksum: z.string().min(1).optional(),
    packageFormat: z.enum(['tgz', 'zip']).optional(),
    version: z.string().min(1).optional(),
    installedAt: z.number().optional(),
    updatedAt: z.number().optional(),
    marketplace: z.object({
        sourceUrl: z.string().min(1),
        pluginId: z.string().min(1),
        repo: z.string().min(1),
        version: z.string().min(1),
        distribution: z.enum(['package', 'hapi-source']).optional(),
        assetUrl: z.string().min(1).optional(),
        sourcePath: z.string().min(1).optional(),
        checksum: z.string().min(1)
    }).strict().optional()
}).strict()

export type PluginInstallMetadata = z.infer<typeof PluginInstallMetadataSchema>

export const PluginScopedConfigStateSchema = z.object({
    config: z.record(z.string(), z.unknown()),
    updatedAt: z.number().optional()
}).strict()

export type PluginScopedConfigState = z.infer<typeof PluginScopedConfigStateSchema>

export const PluginStateEntrySchema = z.object({
    enabled: z.boolean(),
    config: z.record(z.string(), z.unknown()).optional(),
    configUpdatedAt: z.number().optional(),
    scopedConfig: z.record(z.string(), PluginScopedConfigStateSchema).optional(),
    install: PluginInstallMetadataSchema.optional()
}).strict()

export const PluginStateFileSchema = z.object({
    enabled: z.record(z.string(), PluginStateEntrySchema).default({}),
    seededDefaultPluginIds: z.record(z.string(), z.boolean()).optional()
}).strict()

export type PluginStateEntry = z.infer<typeof PluginStateEntrySchema>
export type PluginStateFile = z.infer<typeof PluginStateFileSchema>
