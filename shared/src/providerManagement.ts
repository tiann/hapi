import { z } from 'zod'

export const AgentProviderSchema = z.enum(['claude', 'codex', 'cursor', 'grok', 'kimi', 'opencode', 'pi'])
export type AgentProvider = z.infer<typeof AgentProviderSchema>

export const ProviderProtocolSchema = z.enum([
    'anthropic-messages',
    'openai-responses',
    'openai-chat-completions',
    'gemini-generative-ai'
])
export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>

export type ProviderAgentCapability = {
    managed: boolean
    protocols: readonly ProviderProtocol[]
    credentialTypes: readonly ProviderCredentialType[]
    reason?: string
}

export const ProviderCredentialTypeSchema = z.enum(['api-key', 'auth-token'])
export type ProviderCredentialType = z.infer<typeof ProviderCredentialTypeSchema>

export const AGENT_PROVIDER_CAPABILITIES: Record<AgentProvider, ProviderAgentCapability> = {
    claude: {
        managed: true,
        protocols: ['anthropic-messages'],
        credentialTypes: ['api-key', 'auth-token']
    },
    codex: {
        managed: true,
        protocols: ['openai-responses', 'openai-chat-completions'],
        credentialTypes: ['api-key']
    },
    grok: {
        managed: true,
        protocols: ['openai-chat-completions'],
        credentialTypes: ['api-key']
    },
    cursor: {
        managed: false,
        protocols: [],
        credentialTypes: [],
        reason: 'Cursor uses its native login or API key configuration'
    },
    kimi: {
        managed: false,
        protocols: [],
        credentialTypes: [],
        reason: 'Kimi uses its native configuration file'
    },
    opencode: {
        managed: false,
        protocols: [],
        credentialTypes: [],
        reason: 'OpenCode provider configuration will be enabled by a dedicated adapter'
    },
    pi: {
        managed: false,
        protocols: [],
        credentialTypes: [],
        reason: 'Pi provider configuration will be enabled by a dedicated adapter'
    }
}

export function getProviderAgentCapability(agent: AgentProvider): ProviderAgentCapability {
    return AGENT_PROVIDER_CAPABILITIES[agent]
}

export const CodexWireApiSchema = z.enum(['responses', 'chat'])
export type CodexWireApi = z.infer<typeof CodexWireApiSchema>

export const ProviderModelSourceSchema = z.enum(['provider', 'custom'])
export type ProviderModelSource = z.infer<typeof ProviderModelSourceSchema>

export const ProviderModelSchema = z.object({
    id: z.string().trim().min(1).max(200),
    contextWindow: z.union([z.literal(200_000), z.literal(1_000_000)]),
    source: ProviderModelSourceSchema,
    refreshedAt: z.number().int().nonnegative().optional()
})
export type ProviderModel = z.infer<typeof ProviderModelSchema>

export const ProviderHealthStatusSchema = z.enum(['unverified', 'healthy', 'unhealthy'])
export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatusSchema>

export const ProviderHealthSummarySchema = z.object({
    status: ProviderHealthStatusSchema,
    checkedAt: z.number().int().nonnegative().optional(),
    error: z.string().optional()
})
export type ProviderHealthSummary = z.infer<typeof ProviderHealthSummarySchema>

export function parseProviderModelReference(value: string): Pick<ProviderModel, 'id' | 'contextWindow'> {
    const trimmed = value.trim()
    const match = /^(.*?)(?:\s*\[1m\])?$/i.exec(trimmed)
    const id = match?.[1]?.trim() ?? ''
    if (!id) throw new Error('Model id is required')
    return {
        id,
        contextWindow: /\[1m\]\s*$/i.test(trimmed) ? 1_000_000 : 200_000
    }
}

export function formatProviderModelReference(model: Pick<ProviderModel, 'id' | 'contextWindow'>): string {
    return model.contextWindow === 1_000_000 ? `${model.id}[1M]` : model.id
}

const ProviderModelReferenceInputSchema = z.string().trim().min(1).max(220)

function validateProviderInput(value: {
    agent?: AgentProvider
    protocol?: ProviderProtocol | null
    credentialType?: ProviderCredentialType
    baseUrl?: string | null
    codexWireApi?: CodexWireApi | null
    models?: string[] | null
}, context: z.RefinementCtx): void {
    if (value.agent) {
        const capability = getProviderAgentCapability(value.agent)
        if (!capability.managed) {
            context.addIssue({ code: 'custom', path: ['agent'], message: capability.reason ?? 'This agent only supports its native login' })
        }
        if (value.protocol && !capability.protocols.includes(value.protocol)) {
            context.addIssue({ code: 'custom', path: ['protocol'], message: 'This protocol is not supported by the selected agent' })
        }
        if (value.credentialType && !capability.credentialTypes.includes(value.credentialType)) {
            context.addIssue({ code: 'custom', path: ['credentialType'], message: 'This credential type is not supported by the selected agent' })
        }
        if (value.agent === 'claude' && value.codexWireApi !== undefined && value.codexWireApi !== null) {
            context.addIssue({ code: 'custom', path: ['codexWireApi'], message: 'codexWireApi is only valid for Codex profiles' })
        }
    }
    if (value.baseUrl && !/^https?:\/\//i.test(value.baseUrl)) {
        context.addIssue({ code: 'custom', path: ['baseUrl'], message: 'baseUrl must use HTTP or HTTPS' })
    }
    for (const [index, model] of (value.models ?? []).entries()) {
        try {
            parseProviderModelReference(model)
        } catch {
            context.addIssue({ code: 'custom', path: ['models', index], message: 'Invalid model reference' })
        }
    }
}

export const ProviderProfileInputSchema = z.object({
    name: z.string().trim().min(1).max(100),
    agent: AgentProviderSchema,
    protocol: ProviderProtocolSchema,
    baseUrl: z.string().trim().url().optional(),
    credentialType: ProviderCredentialTypeSchema.default('api-key'),
    apiKey: z.string().trim().min(1).max(20_000),
    defaultModel: z.string().trim().min(1).max(200).optional(),
    models: z.array(ProviderModelReferenceInputSchema).max(500).default([]),
    codexWireApi: CodexWireApiSchema.optional(),
    enabled: z.boolean().default(true)
}).superRefine((value, context) => {
    validateProviderInput(value, context)
})
export type ProviderProfileInput = z.input<typeof ProviderProfileInputSchema>

export const ProviderProfileUpdateSchema = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    agent: AgentProviderSchema.optional(),
    protocol: ProviderProtocolSchema.optional(),
    baseUrl: z.string().trim().url().nullable().optional(),
    credentialType: ProviderCredentialTypeSchema.optional(),
    apiKey: z.string().trim().min(1).max(20_000).optional(),
    defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
    models: z.array(ProviderModelReferenceInputSchema).max(500).nullable().optional(),
    codexWireApi: CodexWireApiSchema.nullable().optional(),
    enabled: z.boolean().optional()
}).superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
        context.addIssue({ code: 'custom', message: 'At least one provider field is required' })
    }
    validateProviderInput(value, context)
})
export type ProviderProfileUpdate = z.input<typeof ProviderProfileUpdateSchema>

export const ProviderProfileViewSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    agent: AgentProviderSchema,
    protocol: ProviderProtocolSchema,
    baseUrl: z.string().optional(),
    credentialType: ProviderCredentialTypeSchema,
    defaultModel: z.string().optional(),
    models: z.array(ProviderModelSchema).default([]),
    health: ProviderHealthSummarySchema.default({ status: 'unverified' }),
    codexWireApi: CodexWireApiSchema.optional(),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    hasSecret: z.boolean(),
    secretHint: z.string().optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int()
})
export type ProviderProfileView = z.infer<typeof ProviderProfileViewSchema>

export const ProviderListRequestSchema = z.object({ agent: AgentProviderSchema.optional() })
export type ProviderListRequest = z.infer<typeof ProviderListRequestSchema>

const ProviderDefaultsSchema = z.object({
    claude: z.string().uuid().nullable(),
    codex: z.string().uuid().nullable(),
    cursor: z.string().uuid().nullable(),
    grok: z.string().uuid().nullable(),
    kimi: z.string().uuid().nullable(),
    opencode: z.string().uuid().nullable(),
    pi: z.string().uuid().nullable()
})

export const ProviderListResponseSchema = z.object({
    success: z.boolean(),
    profiles: z.array(ProviderProfileViewSchema).optional(),
    defaults: ProviderDefaultsSchema.optional(),
    error: z.string().optional()
})
export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>

export const ProviderCreateRequestSchema = ProviderProfileInputSchema
export type ProviderCreateRequest = z.infer<typeof ProviderCreateRequestSchema>

export const ProviderUpdateRequestSchema = z.object({
    id: z.string().uuid(),
    patch: ProviderProfileUpdateSchema
})
export type ProviderUpdateRequest = z.infer<typeof ProviderUpdateRequestSchema>

export const ProviderSetDefaultRequestSchema = z.object({
    agent: AgentProviderSchema,
    id: z.string().uuid().nullable()
})
export type ProviderSetDefaultRequest = z.infer<typeof ProviderSetDefaultRequestSchema>

export const ProviderHealthCheckRequestSchema = z.object({
    id: z.string().uuid(),
    refreshModels: z.boolean().default(true)
})
export type ProviderHealthCheckRequest = z.infer<typeof ProviderHealthCheckRequestSchema>

export const ProviderHealthCheckResponseSchema = z.object({
    success: z.boolean(),
    status: ProviderHealthStatusSchema,
    checkedAt: z.number().int().nonnegative(),
    models: z.array(ProviderModelSchema).optional(),
    error: z.string().optional()
})
export type ProviderHealthCheckResponse = z.infer<typeof ProviderHealthCheckResponseSchema>

export const ProviderMutationResponseSchema = z.object({
    success: z.boolean(),
    profile: ProviderProfileViewSchema.optional(),
    error: z.string().optional()
})
export type ProviderMutationResponse = z.infer<typeof ProviderMutationResponseSchema>
