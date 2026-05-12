import { isObject, safeStringify } from '@hapi/protocol'
import { getInputStringAny, truncate } from '@/lib/toolInputUtils'

export const codexAgentToolNames = [
    'spawn_agent',
    'send_input',
    'resume_agent',
    'wait_agent',
    'close_agent'
] as const

export type CodexAgentToolName = typeof codexAgentToolNames[number]

export function isCodexAgentToolName(toolName: string): toolName is CodexAgentToolName {
    return (codexAgentToolNames as readonly string[]).includes(toolName)
}

export function parseMaybeJsonObject(value: unknown): Record<string, unknown> | null {
    if (isObject(value)) return value
    if (typeof value !== 'string') return null

    const trimmed = value.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

    try {
        const parsed = JSON.parse(trimmed) as unknown
        return isObject(parsed) ? parsed : null
    } catch {
        return null
    }
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function asBooleanLabel(value: unknown): string | null {
    return typeof value === 'boolean' ? (value ? 'true' : 'false') : null
}

function compactText(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

function cleanAgentPromptForSummary(prompt: string): string {
    const withoutTags = prompt
        .replace(/<[^>\n]+>/g, ' ')
        .replace(/\r/g, '\n')
    const noisePatterns = [
        /not alone in the codebase/i,
        /do not revert/i,
        /don't revert/i,
        /list the file paths/i,
        /changed files/i,
        /final answer/i,
        /avoid merge conflicts/i,
        /accommodate the changes/i
    ]
    const lines = withoutTags
        .split('\n')
        .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^#{1,6}\s+/, ''))
        .filter((line) => line.length > 0)
        .filter((line) => !noisePatterns.some((pattern) => pattern.test(line)))
    const candidate = lines.length > 0 ? lines.join(' ') : withoutTags
    return compactText(candidate)
        .replace(/^(task|your task|request|prompt)\s*[:：]\s*/i, '')
        .trim()
}

export function getCodexAgentPrompt(input: unknown): string | null {
    const direct = getInputStringAny(input, ['message', 'prompt'])
    if (direct) return direct

    if (!isObject(input) || !Array.isArray(input.items)) return null

    const textParts = input.items
        .map((item) => isObject(item) && typeof item.text === 'string' ? item.text.trim() : '')
        .filter((text) => text.length > 0)

    return textParts.length > 0 ? textParts.join('\n\n') : null
}

export function summarizeCodexAgentPrompt(prompt: string, maxLength = 80): string | null {
    const cleaned = cleanAgentPromptForSummary(prompt)
    if (!cleaned) return null
    return truncate(cleaned, maxLength)
}

export function getCodexAgentSummary(input: unknown): string | null {
    const explicit = getInputStringAny(input, ['summary', 'title', 'description'])
    if (explicit) return truncate(compactText(explicit), 80)

    const prompt = getCodexAgentPrompt(input)
    if (prompt) {
        const summary = summarizeCodexAgentPrompt(prompt)
        if (summary) return summary
    }

    const agentType = getCodexAgentType(input)
    return agentType ? `${agentType} agent` : null
}

function getCodexAgentStatus(input: unknown): string | null {
    const status = getInputStringAny(input, ['agentStatus', 'status', 'state'])
    return status ? status.trim().toLowerCase() : null
}

function isTerminalCodexAgentStatus(status: string | null): boolean {
    return status === 'completed'
        || status === 'failed'
        || status === 'error'
        || status === 'canceled'
        || status === 'cancelled'
}

function normalizeNonTerminalCodexAgentActivity(activity: string): string {
    const replacements: Array<[RegExp, string]> = [
        [/^Command completed\b/i, 'Command finished'],
        [/^Tool completed\b/i, 'Tool finished'],
        [/^Completed\s*:\s*/i, 'Output ready: '],
        [/^Completed$/i, 'Running']
    ]

    for (const [pattern, replacement] of replacements) {
        if (pattern.test(activity)) {
            return activity.replace(pattern, replacement)
        }
    }

    return activity
}

export function getCodexAgentActivity(input: unknown): string | null {
    const activity = getInputStringAny(input, ['activity', 'statusText', 'status_text', 'agentStatus'])
    if (!activity) return null

    const status = getCodexAgentStatus(input)
    return isTerminalCodexAgentStatus(status)
        ? activity
        : normalizeNonTerminalCodexAgentActivity(activity)
}

export function getCodexAgentReasoningEffort(input: unknown): string | null {
    return getInputStringAny(input, ['reasoning_effort', 'reasoningEffort'])
}

export function formatCodexAgentReasoningEffort(effort: string): string {
    const normalized = effort.trim().toLowerCase()
    if (!normalized || normalized === 'default') return 'reasoning default'
    return `reasoning ${normalized}`
}

export function getCodexAgentReasoningEffortLabel(input: unknown): string | null {
    const effort = getCodexAgentReasoningEffort(input)
    return effort ? formatCodexAgentReasoningEffort(effort) : null
}

export function getCodexAgentType(input: unknown): string | null {
    return getInputStringAny(input, ['agent_type', 'subagent_type', 'type'])
}

export function getCodexAgentTargets(input: unknown): string[] {
    if (!isObject(input)) return []

    const targets = Array.isArray(input.targets)
        ? input.targets.filter((target): target is string => typeof target === 'string' && target.length > 0)
        : []
    if (targets.length > 0) return targets

    const direct = [input.target, input.id, input.agent_id, input.agentId]
        .filter((target): target is string => typeof target === 'string' && target.length > 0)
    return direct
}

export function getCodexAgentFieldRows(toolName: string, input: unknown): Array<{ label: string; value: string }> {
    const rows: Array<{ label: string; value: string }> = []
    const agentId = isObject(input)
        ? asNonEmptyString(input.agentId) ?? asNonEmptyString(input.agent_id)
        : null
    if (agentId) rows.push({ label: 'Agent', value: agentId })

    const statusText = getCodexAgentActivity(input)
    if (statusText) rows.push({ label: 'Status', value: statusText })

    const summary = getCodexAgentSummary(input)
    if (summary) rows.push({ label: 'Work', value: summary })

    const agentType = getCodexAgentType(input)
    if (agentType) rows.push({ label: 'Type', value: agentType })

    const model = getInputStringAny(input, ['model'])
    if (model) rows.push({ label: 'Model', value: model })

    const effort = getCodexAgentReasoningEffort(input)
    if (effort) rows.push({ label: 'Reasoning', value: effort })

    if (isObject(input)) {
        const forkContext = asBooleanLabel(input.fork_context)
        if (forkContext) rows.push({ label: 'Fork context', value: forkContext })

        const timeout = typeof input.timeout_ms === 'number' ? `${input.timeout_ms} ms` : null
        if (timeout) rows.push({ label: 'Timeout', value: timeout })
    }

    const targets = getCodexAgentTargets(input)
    if (targets.length > 0) {
        rows.push({
            label: targets.length === 1 ? (toolName === 'resume_agent' ? 'Agent' : 'Target') : 'Targets',
            value: targets.join(', ')
        })
    }

    return rows
}

export type CodexSpawnAgentResult = {
    agentId: string | null
    nickname: string | null
}

export function parseCodexSpawnAgentResult(result: unknown): CodexSpawnAgentResult | null {
    const obj = parseMaybeJsonObject(result)
    if (!obj) return null

    const agentId = asNonEmptyString(obj.agent_id) ?? asNonEmptyString(obj.agentId) ?? asNonEmptyString(obj.id)
    const nickname = asNonEmptyString(obj.nickname) ?? asNonEmptyString(obj.name)

    if (!agentId && !nickname) return null
    return { agentId, nickname }
}

export type CodexAgentStatus = {
    agentId: string
    state: string
    text: string | null
}

function extractStatusText(value: unknown): string | null {
    if (typeof value === 'string') return value
    if (!isObject(value)) return null

    const candidates = ['completed', 'failed', 'error', 'message', 'output', 'text', 'reason']
    for (const key of candidates) {
        const candidate = value[key]
        if (typeof candidate === 'string') return candidate
    }

    return safeStringify(value)
}

function extractStatusState(value: unknown): string {
    if (!isObject(value)) return 'completed'

    const states = ['completed', 'failed', 'error', 'canceled', 'cancelled', 'killed', 'running', 'pending']
    for (const state of states) {
        if (state in value) return state === 'cancelled' ? 'canceled' : state
    }

    const status = asNonEmptyString(value.status) ?? asNonEmptyString(value.state)
    return status ?? 'completed'
}

export function parseCodexWaitAgentResult(result: unknown): { statuses: CodexAgentStatus[]; timedOut: boolean | null } | null {
    const obj = parseMaybeJsonObject(result)
    if (!obj) return null

    const statusObj = isObject(obj.status) ? obj.status : null
    const statuses: CodexAgentStatus[] = []

    if (statusObj) {
        for (const [agentId, statusValue] of Object.entries(statusObj)) {
            statuses.push({
                agentId,
                state: extractStatusState(statusValue),
                text: extractStatusText(statusValue)
            })
        }
    }

    const timedOut = typeof obj.timed_out === 'boolean'
        ? obj.timed_out
        : typeof obj.timedOut === 'boolean'
            ? obj.timedOut
            : null

    if (statuses.length === 0 && timedOut === null) return null
    return { statuses, timedOut }
}

export function parseCodexCloseAgentResult(result: unknown): CodexAgentStatus | null {
    const obj = parseMaybeJsonObject(result)
    if (!obj) return null

    const previousStatus = isObject(obj.previous_status) ? obj.previous_status
        : isObject(obj.previousStatus) ? obj.previousStatus
            : null
    if (!previousStatus) return null

    return {
        agentId: '',
        state: extractStatusState(previousStatus),
        text: extractStatusText(previousStatus)
    }
}

export function summarizeCodexAgentResult(toolName: string, result: unknown): string | null {
    if (toolName === 'spawn_agent') {
        const parsed = parseCodexSpawnAgentResult(result)
        if (!parsed) return null
        const label = parsed.nickname && parsed.agentId
            ? `${parsed.nickname} (${parsed.agentId})`
            : parsed.nickname ?? parsed.agentId
        return label ? `Launched ${label}` : 'Agent launched'
    }

    if (toolName === 'wait_agent') {
        const parsed = parseCodexWaitAgentResult(result)
        if (!parsed) return null
        if (parsed.statuses.length === 0 && parsed.timedOut) return 'Timed out'
        const completed = parsed.statuses.filter((status) => status.state === 'completed').length
        const failed = parsed.statuses.filter((status) => status.state !== 'completed').length
        const parts = []
        if (completed > 0) parts.push(`${completed} completed`)
        if (failed > 0) parts.push(`${failed} non-completed`)
        if (parsed.timedOut) parts.push('timed out')
        return parts.length > 0 ? parts.join(', ') : 'No agent status yet'
    }

    if (toolName === 'close_agent') {
        const parsed = parseCodexCloseAgentResult(result)
        if (!parsed) return null
        return `Closed (${parsed.state})`
    }

    return null
}
