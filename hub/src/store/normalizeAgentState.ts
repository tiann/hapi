import { isObject } from '@hapi/protocol'
import {
    AgentStateCompletedRequestSchema,
    AgentStateRequestSchema,
    AgentStateSchema,
    ExitPlanImplementationModeSchema,
    PermissionModeSchema
} from '@hapi/protocol/schemas'
import type { AgentState } from '@hapi/protocol/types'
import { z } from 'zod'

const PermissionDecisionSchema = z.enum(['approved', 'approved_for_session', 'denied', 'abort'])
const PermissionAnswersSchema = z.union([
    z.record(z.string(), z.array(z.string())),
    z.record(z.string(), z.object({ answers: z.array(z.string()) }))
])

function normalizeNullishNumber(value: unknown): number | null | undefined {
    if (typeof value === 'number') return value
    if (value === null) return null
    return undefined
}

function normalizeNullishBoolean(value: unknown): boolean | null | undefined {
    if (typeof value === 'boolean') return value
    if (value === null) return null
    return undefined
}

function normalizeMode(value: unknown): z.infer<typeof PermissionModeSchema> | undefined {
    const parsed = PermissionModeSchema.safeParse(value)
    return parsed.success ? parsed.data : undefined
}

function normalizeImplementationMode(
    value: unknown
): z.infer<typeof ExitPlanImplementationModeSchema> | undefined {
    const parsed = ExitPlanImplementationModeSchema.safeParse(value)
    return parsed.success ? parsed.data : undefined
}

function normalizeDecision(value: unknown): z.infer<typeof PermissionDecisionSchema> | undefined {
    const parsed = PermissionDecisionSchema.safeParse(value)
    return parsed.success ? parsed.data : undefined
}

function normalizeAnswers(value: unknown): z.infer<typeof PermissionAnswersSchema> | undefined {
    const parsed = PermissionAnswersSchema.safeParse(value)
    return parsed.success ? parsed.data : undefined
}

function normalizeAllowTools(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    const tools = value.filter((entry): entry is string => typeof entry === 'string')
    return tools.length > 0 ? tools : undefined
}

function normalizeRequest(value: unknown) {
    if (!isObject(value)) return null
    if (typeof value.tool !== 'string' || !('arguments' in value)) return null

    const candidate: Record<string, unknown> = {
        tool: value.tool,
        arguments: value.arguments
    }

    const createdAt = normalizeNullishNumber(value.createdAt)
    if (createdAt !== undefined) {
        candidate.createdAt = createdAt
    }

    const parsed = AgentStateRequestSchema.safeParse(candidate)
    return parsed.success ? parsed.data : null
}

function normalizeCompletedRequest(value: unknown) {
    if (!isObject(value)) return null
    if (typeof value.tool !== 'string' || !('arguments' in value)) return null
    if (value.status !== 'approved' && value.status !== 'denied' && value.status !== 'canceled') return null

    const candidate: Record<string, unknown> = {
        tool: value.tool,
        arguments: value.arguments,
        status: value.status
    }

    const createdAt = normalizeNullishNumber(value.createdAt)
    if (createdAt !== undefined) {
        candidate.createdAt = createdAt
    }

    const completedAt = normalizeNullishNumber(value.completedAt)
    if (completedAt !== undefined) {
        candidate.completedAt = completedAt
    }

    if (typeof value.reason === 'string') {
        candidate.reason = value.reason
    }

    const mode = normalizeMode(value.mode)
    if (mode !== undefined) {
        candidate.mode = mode
    }

    const implementationMode = normalizeImplementationMode(value.implementationMode)
    if (implementationMode !== undefined) {
        candidate.implementationMode = implementationMode
    }

    const decision = normalizeDecision(value.decision)
    if (decision !== undefined) {
        candidate.decision = decision
    }

    const allowTools = normalizeAllowTools(value.allowTools)
    if (allowTools !== undefined) {
        candidate.allowTools = allowTools
    }

    const answers = normalizeAnswers(value.answers)
    if (answers !== undefined) {
        candidate.answers = answers
    }

    const parsed = AgentStateCompletedRequestSchema.safeParse(candidate)
    return parsed.success ? parsed.data : null
}

export function normalizeAgentState(value: unknown): AgentState | null {
    if (value === null || value === undefined) return null

    const parsed = AgentStateSchema.safeParse(value)
    if (parsed.success) {
        return parsed.data
    }

    if (!isObject(value)) {
        return null
    }

    const agentState: AgentState = {}

    const controlledByUser = normalizeNullishBoolean(value.controlledByUser)
    if (controlledByUser !== undefined) {
        agentState.controlledByUser = controlledByUser
    }

    if (isObject(value.requests)) {
        const requests = Object.fromEntries(
            Object.entries(value.requests)
                .map(([id, request]) => [id, normalizeRequest(request)] as const)
                .filter((entry): entry is [string, NonNullable<ReturnType<typeof normalizeRequest>>] => entry[1] !== null)
        )
        agentState.requests = requests
    }

    if (isObject(value.completedRequests)) {
        const completedRequests = Object.fromEntries(
            Object.entries(value.completedRequests)
                .map(([id, request]) => [id, normalizeCompletedRequest(request)] as const)
                .filter((entry): entry is [string, NonNullable<ReturnType<typeof normalizeCompletedRequest>>] => entry[1] !== null)
        )
        agentState.completedRequests = completedRequests
    }

    return agentState
}
