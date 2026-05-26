import { z } from 'zod'
import { AGENT_FLAVORS, getPermissionModesForFlavor, PERMISSION_MODES } from '../modes'

export const AgentIdSchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'agent id must start with an alphanumeric character and contain only alphanumeric characters, dots, colons, underscores, or dashes')
export type AgentId = z.infer<typeof AgentIdSchema>

export const AgentAdapterKindSchema = z.enum(['stdio', 'acp', 'custom-runner-plugin'])
export type AgentAdapterKind = z.infer<typeof AgentAdapterKindSchema>

const AgentPermissionModeSchema = z.enum(PERMISSION_MODES)

export const AgentDescriptorSchema = z.object({
    id: AgentIdSchema,
    displayName: z.string().min(1).max(128),
    description: z.string().max(1000).optional(),
    source: z.enum(['builtin', 'plugin']).default('plugin'),
    pluginId: z.string().min(1).optional(),
    adapter: z.object({
        runtime: z.literal('runner'),
        kind: AgentAdapterKindSchema,
        contributionId: z.string().min(1)
    }).strict(),
    capabilities: z.object({
        supportsResume: z.boolean().optional(),
        supportsPlanMode: z.boolean().optional(),
        supportsImages: z.boolean().optional(),
        supportsFileContext: z.boolean().optional(),
        permissionModes: z.array(AgentPermissionModeSchema).default(['default']),
        models: z.array(z.string().min(1).max(128)).max(100).optional()
    }).strict().default({ permissionModes: ['default'] }),
    available: z.boolean().default(true),
    unavailableReason: z.string().max(1000).optional()
}).strict()
export type AgentDescriptor = z.infer<typeof AgentDescriptorSchema>

export function builtinAgentDescriptors(): AgentDescriptor[] {
    return AGENT_FLAVORS.map((agent) => AgentDescriptorSchema.parse({
        id: agent,
        displayName: agent === 'opencode' ? 'OpenCode' : agent.charAt(0).toUpperCase() + agent.slice(1),
        source: 'builtin',
        adapter: {
            runtime: 'runner',
            kind: agent === 'gemini' || agent === 'opencode' ? 'acp' : 'stdio',
            contributionId: `builtin:${agent}`
        },
        capabilities: {
            supportsResume: true,
            supportsPlanMode: agent === 'claude' || agent === 'cursor',
            supportsFileContext: true,
            permissionModes: [...getPermissionModesForFlavor(agent)]
        },
        available: true
    }))
}
