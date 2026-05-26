import { z } from 'zod'
import { PluginDiagnosticSchema } from './types'

export const RunnerExtensionContributionIdSchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must start with an alphanumeric character and contain only alphanumeric characters, dots, underscores, or dashes')

export const RunnerExtensionPrioritySchema = z.number().int().min(-1000).max(1000).default(0)

export const RunnerSpawnPhaseSchema = z.enum([
    'spawnOptions',
    'environment',
    'command',
    'beforeSpawn',
    'afterSpawn',
    'onExit'
])
export type RunnerSpawnPhase = z.infer<typeof RunnerSpawnPhaseSchema>

export const RunnerSpawnContextSchema = z.object({
    machineId: z.string().min(1),
    agent: z.string().min(1),
    directory: z.string().min(1),
    cwd: z.string().min(1),
    args: z.array(z.string()),
    envKeys: z.array(z.string()),
    sessionType: z.enum(['simple', 'worktree']).optional(),
    worktreeName: z.string().optional(),
    resumeSessionId: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    modelReasoningEffort: z.string().optional(),
    permissionMode: z.string().optional(),
    yolo: z.boolean().optional(),
    manualFields: z.array(z.string().min(1)).optional(),
    pluginFields: z.record(z.string(), z.unknown()).optional()
}).strict()
export type RunnerSpawnContext = z.infer<typeof RunnerSpawnContextSchema>

export const RunnerSpawnOptionsContextSchema = z.object({
    machineId: z.string().min(1),
    agent: z.string().min(1),
    directory: z.string().min(1),
    cwd: z.string().min(1),
    sessionType: z.enum(['simple', 'worktree']).optional(),
    worktreeName: z.string().optional(),
    resumeSessionId: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    modelReasoningEffort: z.string().optional(),
    permissionMode: z.string().optional(),
    yolo: z.boolean().optional(),
    manualFields: z.array(z.string().min(1)).optional(),
    pluginFields: z.record(z.string(), z.unknown()).optional()
}).strict()
export type RunnerSpawnOptionsContext = z.infer<typeof RunnerSpawnOptionsContextSchema>

export const RunnerSpawnOptionDefaultsSchema = z.object({
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    modelReasoningEffort: z.string().min(1).optional(),
    permissionMode: z.string().min(1).optional(),
    yolo: z.boolean().optional()
}).strict()
export type RunnerSpawnOptionDefaults = z.infer<typeof RunnerSpawnOptionDefaultsSchema>

export const RunnerSpawnOptionsProviderProposalSchema = z.object({
    options: RunnerSpawnOptionDefaultsSchema.optional(),
    applied: z.array(z.object({
        label: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        fields: z.array(z.string().min(1)).optional()
    }).strict()).optional(),
    diagnostics: z.array(PluginDiagnosticSchema).optional()
}).strict()
export type RunnerSpawnOptionsProviderProposal = z.infer<typeof RunnerSpawnOptionsProviderProposalSchema>

export const RunnerSpawnOptionsAppliedEntrySchema = z.object({
    pluginId: z.string().min(1),
    contributionId: RunnerExtensionContributionIdSchema,
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    fields: z.array(z.string().min(1)).optional()
}).strict()
export type RunnerSpawnOptionsAppliedEntry = z.infer<typeof RunnerSpawnOptionsAppliedEntrySchema>

export const RunnerEnvironmentProposalSchema = z.object({
    env: z.record(z.string(), z.string()).optional(),
    pathPrepend: z.array(z.string().min(1)).optional(),
    pathAppend: z.array(z.string().min(1)).optional(),
    cwd: z.string().min(1).optional(),
    toolPaths: z.record(z.string(), z.string()).optional().describe('Reserved for future structured tool resolution; current Runner emits a warning and does not apply this field.'),
    diagnostics: z.array(PluginDiagnosticSchema).optional()
}).strict()
export type RunnerEnvironmentProposal = z.infer<typeof RunnerEnvironmentProposalSchema>

export const RunnerCommandResolverProposalSchema = z.object({
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    pathPrepend: z.array(z.string().min(1)).optional(),
    pathAppend: z.array(z.string().min(1)).optional(),
    cwd: z.string().min(1).optional(),
    reason: z.string().optional(),
    diagnostics: z.array(PluginDiagnosticSchema).optional()
}).strict()
export type RunnerCommandResolverProposal = z.infer<typeof RunnerCommandResolverProposalSchema>

export const RunnerSpawnHookProposalSchema = z.object({
    env: z.record(z.string(), z.string()).optional(),
    pathPrepend: z.array(z.string().min(1)).optional(),
    pathAppend: z.array(z.string().min(1)).optional(),
    cwd: z.string().min(1).optional(),
    block: z.object({ reason: z.string().min(1) }).strict().optional(),
    diagnostics: z.array(PluginDiagnosticSchema).optional()
}).strict()
export type RunnerSpawnHookProposal = z.infer<typeof RunnerSpawnHookProposalSchema>

export const RunnerExtensionContributionSummarySchema = z.object({
    pluginId: z.string().min(1),
    id: RunnerExtensionContributionIdSchema,
    type: z.enum(['spawnOptionsProvider', 'environmentProvider', 'commandResolver', 'spawnHook']),
    displayName: z.string().optional(),
    description: z.string().optional(),
    priority: z.number().int().optional(),
    active: z.boolean().default(true)
}).strict()
export type RunnerExtensionContributionSummary = z.infer<typeof RunnerExtensionContributionSummarySchema>

export const RunnerExtensionAuditEventSchema = z.object({
    phase: RunnerSpawnPhaseSchema,
    pluginId: z.string().min(1),
    contributionId: RunnerExtensionContributionIdSchema,
    field: z.string().optional(),
    message: z.string().min(1)
}).strict()
export type RunnerExtensionAuditEvent = z.infer<typeof RunnerExtensionAuditEventSchema>

export const RunnerExtensionDiagnosticSchema = PluginDiagnosticSchema.extend({
    pluginId: z.string().min(1).optional()
}).strict()
export type RunnerExtensionDiagnostic = z.infer<typeof RunnerExtensionDiagnosticSchema>

export const RunnerResolvedSpawnPlanSchema = z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
    displayArgs: z.array(z.string()),
    cwd: z.string().min(1),
    env: z.record(z.string(), z.string()),
    diagnostics: z.array(RunnerExtensionDiagnosticSchema),
    audit: z.array(RunnerExtensionAuditEventSchema),
    blocked: z.object({ reason: z.string().min(1) }).strict().optional()
}).strict()
export type RunnerResolvedSpawnPlan = z.infer<typeof RunnerResolvedSpawnPlanSchema>

export const RunnerResolvedSpawnOptionsSchema = z.object({
    options: z.object({
        directory: z.string().min(1),
        agent: z.string().min(1).optional(),
        sessionId: z.string().optional(),
        resumeSessionId: z.string().optional(),
        approvedNewDirectoryCreation: z.boolean().optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
        modelReasoningEffort: z.string().optional(),
        permissionMode: z.string().optional(),
        yolo: z.boolean().optional(),
        manualFields: z.array(z.string().min(1)).optional(),
        token: z.string().optional(),
        sessionType: z.enum(['simple', 'worktree']).optional(),
        worktreeName: z.string().optional(),
        pluginFields: z.record(z.string(), z.unknown()).optional()
    }).strict(),
    diagnostics: z.array(RunnerExtensionDiagnosticSchema),
    audit: z.array(RunnerExtensionAuditEventSchema),
    applied: z.array(RunnerSpawnOptionsAppliedEntrySchema).default([])
}).strict()
export type RunnerResolvedSpawnOptions = z.infer<typeof RunnerResolvedSpawnOptionsSchema>
