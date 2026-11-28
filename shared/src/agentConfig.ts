import { z } from 'zod'
import { AGENT_FLAVORS, type AgentFlavor } from './modes'
import { getEffortConfigField, getModelConfigField, getSettingsConfigFields, usesNativePermissionSelect } from './flavors'

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

/** Model and effort field shape declared by a flavor and projected into a config descriptor. */
export type AgentConfigFieldShape = {
    readonly kind: Exclude<AgentConfigFieldKind, 'status'>
    readonly optionSource: AgentConfigOptionSource
}

/** Extra create-form settings field declared by a flavor. */
export type AgentConfigSettingField = AgentConfigFieldShape & {
    readonly id: Exclude<AgentConfigFieldId, 'model' | 'effort' | 'permission'>
}

export const AgentConfigDescriptorSchema = z.object({
    flavor: z.string().min(1),
    fields: z.array(AgentConfigFieldDescriptorSchema)
})
export type AgentConfigDescriptor = z.infer<typeof AgentConfigDescriptorSchema>

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

function descriptorFields(flavor: AgentFlavor): AgentConfigFieldDescriptor[] {
    const built: AgentConfigFieldDescriptor[] = []
    const model = getModelConfigField(flavor)
    if (model) {
        built.push({ id: 'model', section: 'model', ...model, availability: 'both' })
    }
    const effort = getEffortConfigField(flavor)
    if (effort) {
        built.push({ id: 'effort', section: 'effort', ...effort, availability: 'both' })
    }
    built.push(usesNativePermissionSelect(flavor) ? PERMISSION : MANAGED_PERMISSION)
    for (const { id, kind, optionSource } of getSettingsConfigFields(flavor)) {
        built.push({ id, section: 'settings', kind, optionSource, availability: 'both' })
    }
    return fields(...built)
}

const BUILTIN_DESCRIPTORS = Object.fromEntries(
    AGENT_FLAVORS.map((flavor) => [flavor, descriptorFields(flavor)])
) as Record<AgentFlavor, AgentConfigFieldDescriptor[]>

export function getAgentConfigDescriptor(flavor: AgentFlavor): AgentConfigDescriptor {
    return { flavor, fields: BUILTIN_DESCRIPTORS[flavor] }
}

export function getBuiltinAgentConfigDescriptors(): AgentConfigDescriptor[] {
    return AGENT_FLAVORS.map(getAgentConfigDescriptor)
}
