import { z } from 'zod'

/** Agent flavors with a stable provider configuration source in v1. */
export const UsageQueryAgentSchema = z.enum(['claude', 'codex', 'kimi'])
export type UsageQueryAgent = z.infer<typeof UsageQueryAgentSchema>

/** Reviewed Runner-side adapters; arbitrary code is never executed. */
export const UsageQueryAdapterSchema = z.enum([
    'json-path',
    'kimi-coding',
    'zenmux-subscription',
    'zhipu-coding',
    'minimax-coding'
])
export type UsageQueryAdapter = z.infer<typeof UsageQueryAdapterSchema>

/** Quota templates are read-only; mutating provider calls require a reviewed adapter. */
export const UsageQueryHttpMethodSchema = z.literal('GET')
export type UsageQueryHttpMethod = z.infer<typeof UsageQueryHttpMethodSchema>

export const UsageQueryResetUnitSchema = z.enum(['iso', 'seconds', 'milliseconds'])
export type UsageQueryResetUnit = z.infer<typeof UsageQueryResetUnitSchema>

export const UsageQueryPercentScaleSchema = z.enum(['percent', 'ratio'])
export type UsageQueryPercentScale = z.infer<typeof UsageQueryPercentScaleSchema>

const UsageQueryPathSchema = z.string().trim().min(1).max(256)

export const UsageQueryWindowSpecSchema = z.object({
    /** Direct utilization value. `ratio` values are multiplied by 100. */
    percentPath: UsageQueryPathSchema.optional(),
    percentScale: UsageQueryPercentScaleSchema.optional(),
    /** Alternative calculation inputs. Used/limit takes precedence over remaining/limit. */
    usedPath: UsageQueryPathSchema.optional(),
    remainingPath: UsageQueryPathSchema.optional(),
    limitPath: UsageQueryPathSchema.optional(),
    resetPath: UsageQueryPathSchema.optional(),
    resetUnit: UsageQueryResetUnitSchema.optional()
}).strict()

export type UsageQueryWindowSpec = z.infer<typeof UsageQueryWindowSpecSchema>

export const UsageQueryRequestSchema = z.object({
    url: z.string().trim().min(1).max(2048),
    method: UsageQueryHttpMethodSchema,
    headers: z.record(z.string().trim().min(1).max(128), z.string().max(2048)).default({})
}).strict()

export type UsageQueryRequest = z.infer<typeof UsageQueryRequestSchema>

export const UsageQueryTemplateSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    name: z.string().trim().min(1).max(128),
    description: z.string().max(500).optional(),
    adapter: UsageQueryAdapterSchema.default('json-path'),
    request: UsageQueryRequestSchema,
    fiveHour: UsageQueryWindowSpecSchema,
    sevenDay: UsageQueryWindowSpecSchema
}).strict()

export type UsageQueryTemplate = z.infer<typeof UsageQueryTemplateSchema>

export const UsageQueryAgentSettingsSchema = z.object({
    enabled: z.boolean(),
    templateId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    template: UsageQueryTemplateSchema
}).strict()

export type UsageQueryAgentSettings = z.infer<typeof UsageQueryAgentSettingsSchema>

export const UsageQueryCredentialStatusSchema = z.object({
    configured: z.boolean(),
    source: z.enum(['environment', 'config', 'none'])
}).strict()

export type UsageQueryCredentialStatus = z.infer<typeof UsageQueryCredentialStatusSchema>

export const UsageQuerySettingsResponseSchema = z.object({
    agent: UsageQueryAgentSchema,
    enabled: z.boolean(),
    templateId: z.string(),
    template: UsageQueryTemplateSchema,
    credentials: z.object({
        baseUrl: UsageQueryCredentialStatusSchema,
        apiKey: UsageQueryCredentialStatusSchema
    }).strict()
}).strict()

export type UsageQuerySettingsResponse = z.infer<typeof UsageQuerySettingsResponseSchema>

export const UsageQueryWindowSchema = z.object({
    usedPercent: z.number().min(0).max(100),
    resetsAt: z.number().nullable()
}).strict()

export type UsageQueryWindow = z.infer<typeof UsageQueryWindowSchema>

export const UsageQueryResultSchema = z.object({
    agent: UsageQueryAgentSchema,
    templateId: z.string(),
    status: z.enum(['success', 'error']),
    fiveHour: UsageQueryWindowSchema.nullable(),
    sevenDay: UsageQueryWindowSchema.nullable(),
    queriedAt: z.number(),
    stale: z.boolean(),
    error: z.string().max(500).optional()
}).strict()

export type UsageQueryResult = z.infer<typeof UsageQueryResultSchema>

export const UsageQueryAgentRequestSchema = z.object({
    agent: UsageQueryAgentSchema
}).strict()

export type UsageQueryAgentRequest = z.infer<typeof UsageQueryAgentRequestSchema>

export const SaveUsageQuerySettingsRequestSchema = z.object({
    agent: UsageQueryAgentSchema,
    enabled: z.boolean(),
    templateId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    template: UsageQueryTemplateSchema
}).strict().refine(
    (value) => value.templateId === value.template.id,
    { path: ['templateId'], message: 'templateId must match template.id' }
)

export type SaveUsageQuerySettingsRequest = z.infer<typeof SaveUsageQuerySettingsRequestSchema>

export const TestUsageQueryRequestSchema = z.object({
    agent: UsageQueryAgentSchema,
    template: UsageQueryTemplateSchema
}).strict()

export type TestUsageQueryRequest = z.infer<typeof TestUsageQueryRequestSchema>

export const QueryUsageRequestSchema = z.object({
    agent: UsageQueryAgentSchema,
    force: z.boolean().optional()
}).strict()

export type QueryUsageRequest = z.infer<typeof QueryUsageRequestSchema>

/** Default safe templates shown by the Web settings editor. */
export const DEFAULT_USAGE_QUERY_TEMPLATES: readonly UsageQueryTemplate[] = [
    {
        id: 'kimi-coding-plan',
        name: 'Kimi Coding Plan',
        description: 'Kimi For Coding 5-hour and 7-day windows.',
        adapter: 'kimi-coding',
        request: {
            url: '{{baseOrigin}}/coding/v1/usages',
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer {{apiKey}}'
            }
        },
        fiveHour: {
            remainingPath: 'limits[0].detail.remaining',
            limitPath: 'limits[0].detail.limit',
            resetPath: 'limits[0].detail.resetTime',
            resetUnit: 'iso'
        },
        sevenDay: {
            remainingPath: 'usage.remaining',
            limitPath: 'usage.limit',
            resetPath: 'usage.resetTime',
            resetUnit: 'iso'
        }
    },
    {
        id: 'zenmux-subscription',
        name: 'ZenMux subscription',
        description: 'ZenMux management API subscription 5-hour and 7-day windows.',
        adapter: 'zenmux-subscription',
        request: {
            url: '{{baseOrigin}}/api/v1/management/subscription/detail',
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer {{apiKey}}'
            }
        },
        fiveHour: {},
        sevenDay: {}
    },
    {
        id: 'zhipu-coding-plan',
        name: 'Zhipu GLM Coding Plan',
        description: 'Zhipu GLM personal Coding Plan quota windows.',
        adapter: 'zhipu-coding',
        request: {
            url: '{{baseOrigin}}/api/monitor/usage/quota/limit',
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: '{{apiKey}}'
            }
        },
        fiveHour: {},
        sevenDay: {}
    },
    {
        id: 'minimax-coding-plan',
        name: 'MiniMax Coding Plan',
        description: 'MiniMax Coding Plan general-model 5-hour and weekly windows.',
        adapter: 'minimax-coding',
        request: {
            url: '{{baseOrigin}}/v1/api/openplatform/coding_plan/remains',
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer {{apiKey}}'
            }
        },
        fiveHour: {},
        sevenDay: {}
    },
    {
        id: 'generic-rate-limits',
        name: 'Generic rate-limit windows',
        description: 'Example for APIs exposing used/limit/reset fields; edit paths as needed.',
        adapter: 'json-path',
        request: {
            url: '{{baseUrl}}/usage',
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer {{apiKey}}'
            }
        },
        fiveHour: {
            usedPath: 'limits[0].used',
            limitPath: 'limits[0].limit',
            resetPath: 'limits[0].resetTime',
            resetUnit: 'iso'
        },
        sevenDay: {
            usedPath: 'usage.used',
            limitPath: 'usage.limit',
            resetPath: 'usage.resetTime',
            resetUnit: 'iso'
        }
    },
    {
        id: 'custom-json-paths',
        name: 'Custom JSON paths',
        description: 'Blank safe template; fill JSON paths without exposing credentials.',
        adapter: 'json-path',
        request: {
            url: '{{baseUrl}}/usage',
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer {{apiKey}}'
            }
        },
        fiveHour: {},
        sevenDay: {}
    }
]

export const DEFAULT_USAGE_QUERY_TEMPLATE = DEFAULT_USAGE_QUERY_TEMPLATES.find((template) => template.id === 'generic-rate-limits')
    ?? DEFAULT_USAGE_QUERY_TEMPLATES[0]

export const UsageQuerySettingsSchema = z.object({
    claude: UsageQueryAgentSettingsSchema,
    codex: UsageQueryAgentSettingsSchema,
    kimi: UsageQueryAgentSettingsSchema
}).strict()

export type UsageQuerySettings = z.infer<typeof UsageQuerySettingsSchema>

export const USAGE_QUERY_TIMEOUT_MS = 10_000
export const USAGE_QUERY_CACHE_TTL_MS = 5 * 60_000
export const USAGE_QUERY_RETRY_COOLDOWN_MS = 30_000
export const USAGE_QUERY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
