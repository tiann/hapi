import { z } from 'zod'
import { AGENT_FLAVORS, type AgentFlavor, type PermissionMode } from './modes'

export const AgentConfigFieldIdSchema = z.enum([
    'model',
    'effort',
    'permission',
    'serviceTier',
    'collaborationMode'
])
export type AgentConfigFieldId = z.infer<typeof AgentConfigFieldIdSchema>

export const AgentConfigSectionSchema = z.enum(['model', 'effort', 'permission', 'settings'])
export type AgentConfigSection = z.infer<typeof AgentConfigSectionSchema>

export const AgentConfigFieldKindSchema = z.enum(['select', 'grouped-select', 'dependent-select', 'status'])
export type AgentConfigFieldKind = z.infer<typeof AgentConfigFieldKindSchema>

export const AgentConfigOptionSourceSchema = z.enum(['static', 'machine', 'directory', 'session', 'model'])
export type AgentConfigOptionSource = z.infer<typeof AgentConfigOptionSourceSchema>

export const AgentConfigAvailabilitySchema = z.enum(['create', 'session', 'both', 'managed'])
export type AgentConfigAvailability = z.infer<typeof AgentConfigAvailabilitySchema>

export const AgentConfigFieldDescriptorSchema = z.object({
    id: AgentConfigFieldIdSchema,
    section: AgentConfigSectionSchema,
    kind: AgentConfigFieldKindSchema,
    optionSource: AgentConfigOptionSourceSchema.optional(),
    availability: AgentConfigAvailabilitySchema,
    unavailableReason: z.string().optional()
})
export type AgentConfigFieldDescriptor = z.infer<typeof AgentConfigFieldDescriptorSchema>

export const AgentConfigDescriptorSchema = z.object({
    flavor: z.string().min(1),
    fields: z.array(AgentConfigFieldDescriptorSchema)
})
export type AgentConfigDescriptor = z.infer<typeof AgentConfigDescriptorSchema>

const MODEL: AgentConfigFieldDescriptor = {
    id: 'model', section: 'model', kind: 'select', optionSource: 'static', availability: 'both'
}
const PERMISSION: AgentConfigFieldDescriptor = {
    id: 'permission', section: 'permission', kind: 'select', optionSource: 'static', availability: 'both'
}
const MANAGED_PERMISSION: AgentConfigFieldDescriptor = {
    id: 'permission',
    section: 'permission',
    kind: 'status',
    availability: 'managed',
    unavailableReason: 'Managed by agent'
}

function fields(...fields: AgentConfigFieldDescriptor[]): AgentConfigFieldDescriptor[] {
    return fields
}

const BUILTIN_DESCRIPTORS: Record<AgentFlavor, AgentConfigFieldDescriptor[]> = {
    agy: fields({ ...MODEL, optionSource: 'machine' }, PERMISSION),
    claude: fields(MODEL, { id: 'effort', section: 'effort', kind: 'select', optionSource: 'static', availability: 'both' }, PERMISSION),
    codex: fields(
        { ...MODEL, optionSource: 'machine' },
        { id: 'effort', section: 'effort', kind: 'select', optionSource: 'model', availability: 'both' },
        PERMISSION,
        { id: 'serviceTier', section: 'settings', kind: 'select', optionSource: 'model', availability: 'both' },
        { id: 'collaborationMode', section: 'settings', kind: 'select', optionSource: 'static', availability: 'both' }
    ),
    copilot: fields({ ...MODEL, optionSource: 'directory' }, PERMISSION),
    cursor: fields({ id: 'model', section: 'model', kind: 'dependent-select', optionSource: 'machine', availability: 'both' }, PERMISSION),
    gemini: fields(MODEL, PERMISSION),
    grok: fields(
        { ...MODEL, optionSource: 'directory' },
        { id: 'effort', section: 'effort', kind: 'select', optionSource: 'model', availability: 'both' },
        PERMISSION
    ),
    kimi: fields(MODEL, PERMISSION),
    opencode: fields(
        { ...MODEL, optionSource: 'directory' },
        { id: 'effort', section: 'effort', kind: 'select', optionSource: 'model', availability: 'both' },
        PERMISSION
    ),
    pi: fields(
        { id: 'model', section: 'model', kind: 'grouped-select', optionSource: 'machine', availability: 'both' },
        { id: 'effort', section: 'effort', kind: 'select', optionSource: 'static', availability: 'both' },
        MANAGED_PERMISSION
    )
}

export function getAgentConfigDescriptor(flavor: AgentFlavor): AgentConfigDescriptor {
    return { flavor, fields: BUILTIN_DESCRIPTORS[flavor] }
}

export function getBuiltinAgentConfigDescriptors(): AgentConfigDescriptor[] {
    return AGENT_FLAVORS.map(getAgentConfigDescriptor)
}

export function resolveHapiYoloPermissionMode(flavor: AgentFlavor): PermissionMode | null {
    switch (flavor) {
        case 'claude':
        case 'grok':
            return 'bypassPermissions'
        case 'agy':
            return 'always-proceed'
        case 'codex':
        case 'copilot':
        case 'cursor':
        case 'gemini':
        case 'kimi':
        case 'opencode':
            return 'yolo'
        case 'pi':
            return null
    }
}
