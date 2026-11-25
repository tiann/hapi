import { isObject } from '@hapi/protocol'
import type { ChatToolCall } from '@/chat/types'

const GOAL_TOOL_NAMES = ['create_goal', 'get_goal', 'update_goal'] as const
export type GoalToolName = typeof GOAL_TOOL_NAMES[number]

export function getGoalToolName(name: string): GoalToolName | null {
    const candidate = name.startsWith('functions.') ? name.slice('functions.'.length) : name
    return (GOAL_TOOL_NAMES as readonly string[]).includes(candidate) ? candidate as GoalToolName : null
}

export function isGoalToolName(name: string): boolean {
    return getGoalToolName(name) !== null
}

export type GoalSnapshot = {
    objective: string
    status: string
    threadId?: string
    tokenBudget?: number | null
    tokensUsed?: number
    timeUsedSeconds?: number
    createdAt?: number
    updatedAt?: number
}

export type GoalResult = { kind: 'goal'; goal: GoalSnapshot } | { kind: 'empty' }

function readField(record: Record<string, unknown>, camel: string, snake: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, camel) ? record[camel] : record[snake]
}

function parseSnapshot(value: unknown): GoalSnapshot | null {
    if (!isObject(value) || typeof value.objective !== 'string' || !value.objective.trim()
        || typeof value.status !== 'string' || !value.status.trim()) return null

    const goal: GoalSnapshot = { objective: value.objective, status: value.status }
    const threadId = readField(value, 'threadId', 'thread_id')
    if (typeof threadId === 'string' && threadId.trim()) goal.threadId = threadId

    const fields = [
        ['tokenBudget', 'token_budget'], ['tokensUsed', 'tokens_used'],
        ['timeUsedSeconds', 'time_used_seconds'], ['createdAt', 'created_at'], ['updatedAt', 'updated_at']
    ] as const
    for (const [camel, snake] of fields) {
        const number = readField(value, camel, snake)
        if (camel === 'tokenBudget' && number === null) goal.tokenBudget = null
        else if (typeof number === 'number' && Number.isFinite(number) && number >= 0) goal[camel] = number
    }
    return goal
}

/** Only unwrap documented result/text containers; arbitrary objects are not searched. */
export function parseGoalToolResult(result: unknown, depth = 0): GoalResult | null {
    if (depth > 4) return null
    if (typeof result === 'string') {
        const text = result.trim()
        if (!text.startsWith('{') && !text.startsWith('[')) return null
        try {
            return parseGoalToolResult(JSON.parse(text) as unknown, depth)
        } catch {
            return null
        }
    }
    if (Array.isArray(result)) {
        if (result.length === 0 || !result.every((block) => isObject(block)
            && block.type === 'text' && typeof block.text === 'string')) return null
        return parseGoalToolResult(result.map((block) => block.text).join('\n'), depth + 1)
    }
    if (!isObject(result) || result.isError === true || result.is_error === true
        || (result.error !== undefined && result.error !== null)) return null

    if (Object.prototype.hasOwnProperty.call(result, 'goal')) {
        if (result.goal === null) return { kind: 'empty' }
        const goal = parseSnapshot(result.goal)
        return goal ? { kind: 'goal', goal } : null
    }
    const goal = parseSnapshot(result)
    if (goal) return { kind: 'goal', goal }
    for (const key of ['result', 'output', 'content', 'text']) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            return parseGoalToolResult(result[key], depth + 1)
        }
    }
    return null
}

/** The shared Codex /goal command emits a standalone {goal} status message. */
export function parseGoalStatusMessage(message: string): GoalResult | null {
    try {
        const value: unknown = JSON.parse(message)
        if (!isObject(value) || Object.keys(value).length !== 1
            || !Object.prototype.hasOwnProperty.call(value, 'goal')) return null
        return parseGoalToolResult(value)
    } catch {
        return null
    }
}

export function getPendingGoalRequest(input: unknown): { kind: 'objective' | 'status'; text: string } | null {
    if (!isObject(input)) return null
    if (typeof input.objective === 'string' && input.objective.trim()) return { kind: 'objective', text: input.objective }
    return typeof input.status === 'string' && input.status.trim() ? { kind: 'status', text: input.status } : null
}

export function canShowGoalPreview(tool: Pick<ChatToolCall, 'input' | 'result' | 'state'>): boolean {
    if (tool.state === 'error') return false
    if (tool.state === 'completed') return parseGoalToolResult(tool.result) !== null
    return getPendingGoalRequest(tool.input) !== null
}
