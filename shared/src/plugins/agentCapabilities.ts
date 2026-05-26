import { z } from 'zod'
import { PERMISSION_MODES } from '../modes'
import { AgentIdSchema } from './agentDescriptors'
import { PluginDiagnosticSchema } from './types'

const CapabilityIdSchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must start with an alphanumeric character and contain only alphanumeric characters, dots, colons, underscores, or dashes')

const PermissionModeSchema = z.enum(PERMISSION_MODES)

export const AgentModelDescriptorSchema = z.object({
    id: z.string().min(1).max(128),
    displayName: z.string().min(1).max(128).optional(),
    description: z.string().max(1000).optional(),
    serviceTier: z.string().min(1).max(64).optional(),
    contextWindow: z.number().int().positive().optional(),
    default: z.boolean().optional()
}).strict()
export type AgentModelDescriptor = z.infer<typeof AgentModelDescriptorSchema>

export const AgentPermissionModeDescriptorSchema = z.object({
    mode: PermissionModeSchema,
    label: z.string().min(1).max(128).optional(),
    description: z.string().max(1000).optional(),
    risk: z.enum(['low', 'medium', 'high', 'danger']).optional(),
    default: z.boolean().optional()
}).strict()
export type AgentPermissionModeDescriptor = z.infer<typeof AgentPermissionModeDescriptorSchema>

export const AgentProfileDescriptorSchema = z.object({
    id: CapabilityIdSchema,
    displayName: z.string().min(1).max(128),
    description: z.string().max(1000).optional(),
    default: z.boolean().optional()
}).strict()
export type AgentProfileDescriptor = z.infer<typeof AgentProfileDescriptorSchema>

export const AgentNativeSessionDescriptorSchema = z.object({
    id: CapabilityIdSchema,
    title: z.string().min(1).max(256).optional(),
    cwd: z.string().min(1).max(4096).optional(),
    updatedAt: z.number().int().nonnegative().optional(),
    importable: z.boolean().default(true)
}).strict()
export type AgentNativeSessionDescriptor = z.infer<typeof AgentNativeSessionDescriptorSchema>

export const AgentUsageDescriptorSchema = z.object({
    scope: z.enum(['agent', 'session']).default('agent'),
    sessionId: z.string().min(1).max(256).optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    limitLabel: z.string().min(1).max(128).optional()
}).strict()
export type AgentUsageDescriptor = z.infer<typeof AgentUsageDescriptorSchema>

export const AgentSkillDescriptorSchema = z.object({
    name: z.string().min(1).max(128),
    description: z.string().max(1000).optional()
}).strict()
export type AgentSkillDescriptor = z.infer<typeof AgentSkillDescriptorSchema>

export const AgentSlashCommandDescriptorSchema = z.object({
    name: z.string().min(1).max(128),
    description: z.string().max(1000).optional()
}).strict()
export type AgentSlashCommandDescriptor = z.infer<typeof AgentSlashCommandDescriptorSchema>

export const AgentCapabilityProviderResultSchema = z.object({
    models: z.array(AgentModelDescriptorSchema).max(100).optional(),
    permissionModes: z.array(AgentPermissionModeDescriptorSchema).max(20).optional(),
    profiles: z.array(AgentProfileDescriptorSchema).max(100).optional(),
    sessions: z.array(AgentNativeSessionDescriptorSchema).max(100).optional(),
    usage: z.array(AgentUsageDescriptorSchema).max(100).optional(),
    skills: z.array(AgentSkillDescriptorSchema).max(100).optional(),
    slashCommands: z.array(AgentSlashCommandDescriptorSchema).max(100).optional(),
    diagnostics: z.array(PluginDiagnosticSchema).max(100).optional()
}).strict()
export type AgentCapabilityProviderResult = z.infer<typeof AgentCapabilityProviderResultSchema>

export const AgentCapabilityProviderSnapshotSchema = z.object({
    agentId: AgentIdSchema,
    pluginId: z.string().min(1).max(128),
    contributionId: CapabilityIdSchema,
    updatedAt: z.number().int().nonnegative(),
    capabilities: AgentCapabilityProviderResultSchema,
    diagnostics: z.array(PluginDiagnosticSchema).default([])
}).strict()
export type AgentCapabilityProviderSnapshot = z.infer<typeof AgentCapabilityProviderSnapshotSchema>

export const AgentHistoryImportMessageSchema = z.object({
    role: z.enum(['user', 'agent', 'system']),
    content: z.string().min(1).max(200_000),
    createdAt: z.number().int().nonnegative().optional()
}).strict()
export type AgentHistoryImportMessage = z.infer<typeof AgentHistoryImportMessageSchema>

export const AgentHistoryImportResultSchema = z.object({
    messages: z.array(AgentHistoryImportMessageSchema).max(10_000)
}).strict()
export type AgentHistoryImportResult = z.infer<typeof AgentHistoryImportResultSchema>
