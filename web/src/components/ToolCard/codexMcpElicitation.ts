import { isObject } from '@hapi/protocol'

export type CodexMcpElicitationInput =
    | {
        requestId: string
        threadId: string
        turnId: string | null
        serverName: string
        mode: 'form'
        message: string
        requestedSchema: Record<string, unknown>
        meta?: {
            toolTitle?: string
            toolDescription?: string
        }
        url?: undefined
        elicitationId?: undefined
    }
    | {
        requestId: string
        threadId: string
        turnId: string | null
        serverName: string
        mode: 'url'
        message: string
        url: string
        meta?: {
            toolTitle?: string
            toolDescription?: string
        }
        elicitationId?: string
        requestedSchema?: undefined
    }

export type CodexMcpElicitationResult = {
    action: 'accept' | 'decline' | 'cancel'
    content: unknown | null
}

export type CodexMcpElicitationPrimitive = string | number | boolean

type CodexMcpElicitationFormFieldBase = {
    key: string
    label: string
    description?: string
    required: boolean
}

export type CodexMcpElicitationFormField =
    | (CodexMcpElicitationFormFieldBase & {
        kind: 'string'
    })
    | (CodexMcpElicitationFormFieldBase & {
        kind: 'number' | 'integer'
    })
    | (CodexMcpElicitationFormFieldBase & {
        kind: 'boolean'
    })
    | (CodexMcpElicitationFormFieldBase & {
        kind: 'enum'
        options: Array<{
            label: string
            value: CodexMcpElicitationPrimitive
        }>
    })
    | (CodexMcpElicitationFormFieldBase & {
        kind: 'json'
        schema: Record<string, unknown>
    })

export type CodexMcpElicitationFormSchema =
    | {
        kind: 'object'
        fields: CodexMcpElicitationFormField[]
    }
    | {
        kind: 'unsupported'
        reason: string
    }

export type CodexMcpElicitationFormState = Record<string, string | boolean | null>

export type CodexMcpElicitationFormSubmission =
    | {
        ok: true
        content: Record<string, unknown>
    }
    | {
        ok: false
        error: string
        fieldKey?: string
    }

export function isCodexMcpElicitationToolName(toolName: string): boolean {
    return toolName === 'CodexMcpElicitation'
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function getSchemaTypes(schema: Record<string, unknown>): string[] {
    const rawType = schema.type
    const rawTypes = typeof rawType === 'string'
        ? [rawType]
        : Array.isArray(rawType)
            ? rawType.filter((value): value is string => typeof value === 'string')
            : []

    return [...new Set(rawTypes.filter((value) => value !== 'null'))]
}

function isPrimitiveEnumValue(value: unknown): value is CodexMcpElicitationPrimitive {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function normalizeFormField(
    key: string,
    schema: unknown,
    required: boolean
): CodexMcpElicitationFormField {
    const schemaRecord = isObject(schema) ? schema as Record<string, unknown> : null
    const label = schemaRecord ? (asString(schemaRecord.title) ?? key) : key
    const description = schemaRecord ? (asString(schemaRecord.description) ?? undefined) : undefined

    const base = {
        key,
        label,
        description,
        required
    }

    if (!schemaRecord) {
        return {
            ...base,
            kind: 'json',
            schema: {}
        }
    }

    const enumValues = Array.isArray(schemaRecord.enum)
        ? schemaRecord.enum.filter(isPrimitiveEnumValue)
        : []
    if (enumValues.length > 0) {
        return {
            ...base,
            kind: 'enum',
            options: enumValues.map((value) => ({
                label: String(value),
                value
            }))
        }
    }

    const schemaTypes = getSchemaTypes(schemaRecord)
    if (schemaTypes.length === 1) {
        const schemaType = schemaTypes[0]
        if (schemaType === 'string') {
            return {
                ...base,
                kind: 'string'
            }
        }
        if (schemaType === 'number' || schemaType === 'integer') {
            return {
                ...base,
                kind: schemaType
            }
        }
        if (schemaType === 'boolean') {
            return {
                ...base,
                kind: 'boolean'
            }
        }
    }

    if (
        schemaTypes.includes('object')
        || schemaTypes.includes('array')
        || isObject(schemaRecord.properties)
        || schemaRecord.items !== undefined
    ) {
        return {
            ...base,
            kind: 'json',
            schema: schemaRecord
        }
    }

    return {
        ...base,
        kind: 'json',
        schema: schemaRecord
    }
}

export function normalizeCodexMcpElicitationFormSchema(
    requestedSchema: Record<string, unknown>
): CodexMcpElicitationFormSchema {
    const rootTypes = getSchemaTypes(requestedSchema)
    const properties = isObject(requestedSchema.properties)
        ? requestedSchema.properties as Record<string, unknown>
        : null
    const isObjectRoot = rootTypes.includes('object') || properties !== null

    if (!isObjectRoot || !properties) {
        return {
            kind: 'unsupported',
            reason: 'This MCP request uses an unsupported root schema. Only object forms are supported right now.'
        }
    }

    const requiredKeys = new Set(
        Array.isArray(requestedSchema.required)
            ? requestedSchema.required.filter((value): value is string => typeof value === 'string')
            : []
    )

    return {
        kind: 'object',
        fields: Object.entries(properties).map(([key, schema]) => (
            normalizeFormField(key, schema, requiredKeys.has(key))
        ))
    }
}

export function createCodexMcpElicitationFormState(
    schema: CodexMcpElicitationFormSchema
): CodexMcpElicitationFormState {
    if (schema.kind !== 'object') {
        return {}
    }

    const nextState: CodexMcpElicitationFormState = {}
    for (const field of schema.fields) {
        if (field.kind === 'boolean') {
            nextState[field.key] = field.required ? false : null
            continue
        }
        nextState[field.key] = ''
    }
    return nextState
}

function requiredFieldError(field: CodexMcpElicitationFormField): CodexMcpElicitationFormSubmission {
    return {
        ok: false,
        error: `${field.label} is required`,
        fieldKey: field.key
    }
}

export function buildCodexMcpElicitationFormContent(
    schema: CodexMcpElicitationFormSchema,
    state: CodexMcpElicitationFormState
): CodexMcpElicitationFormSubmission {
    if (schema.kind !== 'object') {
        return {
            ok: false,
            error: schema.reason
        }
    }

    const content: Record<string, unknown> = {}

    for (const field of schema.fields) {
        const draftValue = state[field.key]

        if (field.kind === 'string') {
            const value = typeof draftValue === 'string' ? draftValue : ''
            if (value.trim().length === 0) {
                if (field.required) return requiredFieldError(field)
                continue
            }
            content[field.key] = value
            continue
        }

        if (field.kind === 'number' || field.kind === 'integer') {
            const value = typeof draftValue === 'string' ? draftValue : ''
            if (value.trim().length === 0) {
                if (field.required) return requiredFieldError(field)
                continue
            }

            const parsedNumber = Number(value)
            if (!Number.isFinite(parsedNumber)) {
                return {
                    ok: false,
                    error: `${field.label} must be a number`,
                    fieldKey: field.key
                }
            }
            if (field.kind === 'integer' && !Number.isInteger(parsedNumber)) {
                return {
                    ok: false,
                    error: `${field.label} must be an integer`,
                    fieldKey: field.key
                }
            }

            content[field.key] = parsedNumber
            continue
        }

        if (field.kind === 'boolean') {
            if (typeof draftValue === 'boolean') {
                content[field.key] = draftValue
                continue
            }
            if (field.required) {
                content[field.key] = false
            }
            continue
        }

        if (field.kind === 'enum') {
            const selectedIndex = typeof draftValue === 'string' ? draftValue : ''
            if (selectedIndex.length === 0) {
                if (field.required) return requiredFieldError(field)
                continue
            }

            const optionIndex = Number(selectedIndex)
            if (
                !Number.isInteger(optionIndex)
                || optionIndex < 0
                || optionIndex >= field.options.length
            ) {
                return {
                    ok: false,
                    error: `Please choose a valid value for ${field.label}`,
                    fieldKey: field.key
                }
            }

            content[field.key] = field.options[optionIndex]?.value
            continue
        }

        const value = typeof draftValue === 'string' ? draftValue : ''
        if (value.trim().length === 0) {
            if (field.required) return requiredFieldError(field)
            continue
        }

        try {
            content[field.key] = JSON.parse(value)
        } catch {
            return {
                ok: false,
                error: `${field.label} must be valid JSON`,
                fieldKey: field.key
            }
        }
    }

    return {
        ok: true,
        content
    }
}

export function parseCodexMcpElicitationInput(input: unknown): CodexMcpElicitationInput | null {
    if (!isObject(input)) return null

    const requestId = asString(input.requestId)
    const threadId = asString(input.threadId)
    const serverName = asString(input.serverName)
    const mode = input.mode
    const message = asString(input.message) ?? ''
    const turnId = typeof input.turnId === 'string' ? input.turnId : null
    const meta = isObject(input._meta)
        ? {
            toolTitle: asString(input._meta.tool_title) ?? undefined,
            toolDescription: asString(input._meta.tool_description) ?? undefined
        }
        : undefined

    if (!requestId || !threadId || !serverName) return null

    if (mode === 'form' && isObject(input.requestedSchema)) {
        return {
            requestId,
            threadId,
            turnId,
            serverName,
            mode,
            message,
            requestedSchema: input.requestedSchema as Record<string, unknown>,
            meta
        }
    }

    if (mode === 'url') {
        const url = asString(input.url)
        if (!url) return null
        return {
            requestId,
            threadId,
            turnId,
            serverName,
            mode,
            message,
            url,
            meta,
            elicitationId: asString(input.elicitationId) ?? undefined
        }
    }

    return null
}

export function parseCodexMcpElicitationResult(result: unknown): CodexMcpElicitationResult | null {
    if (typeof result === 'string') {
        try {
            return parseCodexMcpElicitationResult(JSON.parse(result))
        } catch {
            return null
        }
    }

    if (!isObject(result)) return null
    const action = result.action
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
        return null
    }

    return {
        action,
        content: result.content ?? null
    }
}
