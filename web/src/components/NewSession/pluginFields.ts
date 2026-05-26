import {
    WebNewSessionFieldDescriptorSchema,
    localizeWebText,
    type PluginWebContributionView,
    type WebNewSessionFieldDescriptor
} from '@hapi/protocol/plugins'

export type NewSessionPluginField = WebNewSessionFieldDescriptor & {
    pluginId: string
    pluginName?: string
}

export type NewSessionPluginFieldError = {
    key: string
    message: string
}

export function collectNewSessionPluginFields(
    webContributions: PluginWebContributionView[] | undefined,
    agentId: string
): NewSessionPluginField[] {
    const fields: NewSessionPluginField[] = []
    for (const contribution of webContributions ?? []) {
        for (const rawField of contribution.contributions.newSessionFields ?? []) {
            const parsed = WebNewSessionFieldDescriptorSchema.safeParse(rawField)
            if (!parsed.success) continue
            const field = parsed.data
            if (field.agentIds && !field.agentIds.includes(agentId)) continue
            fields.push({ ...field, pluginId: contribution.pluginId, pluginName: contribution.pluginName })
        }
    }
    return fields
}

function fieldStorageKey(field: NewSessionPluginField): string {
    return `${field.pluginId}.${field.key}`
}

function isBlank(value: unknown): boolean {
    return value === undefined || value === null || value === ''
}

function validationMessage(
    locale: string | undefined,
    key: 'required' | 'number' | 'select',
    label: string
): string {
    if (locale === 'zh-CN') {
        if (key === 'required') return `请填写${label}。`
        if (key === 'number') return `${label}必须是有限数字。`
        return `${label}必须是列表中的选项。`
    }

    if (key === 'required') return `${label} is required.`
    if (key === 'number') return `${label} must be a finite number.`
    return `${label} must be one of the listed options.`
}

export function validateNewSessionPluginFieldValues(
    fields: NewSessionPluginField[],
    values: Record<string, unknown>,
    locale?: string
): NewSessionPluginFieldError[] {
    const errors: NewSessionPluginFieldError[] = []
    for (const field of fields) {
        const key = fieldStorageKey(field)
        const value = values[key] ?? field.defaultValue
        const label = localizeWebText(field.label, locale)
        if (field.required && isBlank(value)) {
            errors.push({ key, message: validationMessage(locale, 'required', label) })
            continue
        }
        if (!isBlank(value) && field.type === 'number') {
            const parsed = typeof value === 'number' ? value : Number(value)
            if (!Number.isFinite(parsed)) {
                errors.push({ key, message: validationMessage(locale, 'number', label) })
            }
        }
        if (!isBlank(value) && field.type === 'select') {
            const allowed = new Set((field.options ?? []).map((option) => option.value))
            if (!allowed.has(String(value))) {
                errors.push({ key, message: validationMessage(locale, 'select', label) })
            }
        }
    }
    return errors
}

export function buildNewSessionPluginFieldPayload(
    fields: NewSessionPluginField[],
    values: Record<string, unknown>
): Record<string, unknown> | undefined {
    const payload: Record<string, unknown> = {}
    for (const field of fields) {
        const key = fieldStorageKey(field)
        const rawValue = values[key] ?? field.defaultValue
        if (isBlank(rawValue)) continue
        const pluginPayload = payload[field.pluginId]
        const nextPluginPayload = pluginPayload && typeof pluginPayload === 'object' && !Array.isArray(pluginPayload)
            ? pluginPayload as Record<string, unknown>
            : {}
        if (field.type === 'number') {
            const parsed = typeof rawValue === 'number' ? rawValue : Number(rawValue)
            if (!Number.isFinite(parsed)) continue
            nextPluginPayload[field.key] = parsed
        } else if (field.type === 'select') {
            const allowed = new Set((field.options ?? []).map((option) => option.value))
            if (!allowed.has(String(rawValue))) continue
            nextPluginPayload[field.key] = String(rawValue)
        } else {
            nextPluginPayload[field.key] = rawValue
        }
        payload[field.pluginId] = nextPluginPayload
    }
    return Object.keys(payload).length > 0 ? payload : undefined
}

export function newSessionPluginFieldStorageKey(field: NewSessionPluginField): string {
    return fieldStorageKey(field)
}
