import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { TodoItemSchema, TodosSchema } from '@hapi/protocol/schemas'
import type { TodoItem } from '@hapi/protocol/types'

export { TodoItemSchema, TodosSchema }
export type { TodoItem }

function normalizeTodoStatus(value: unknown): TodoItem['status'] {
    if (typeof value !== 'string') return 'pending'
    const status = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
    if (status === 'completed' || status === 'complete' || status === 'done') return 'completed'
    if (status === 'in_progress' || status === 'inprogress' || status === 'active' || status === 'running') {
        return 'in_progress'
    }
    return 'pending'
}

function normalizeTodoPriority(value: unknown): TodoItem['priority'] {
    if (value === 'high' || value === 'low') return value
    return 'medium'
}

function extractText(value: Record<string, unknown>): string | null {
    for (const key of ['content', 'step', 'text', 'title', 'description']) {
        const candidate = value[key]
        if (typeof candidate !== 'string') continue
        const text = candidate.trim()
        if (text) return text
    }
    return null
}

function normalizePlanEntries(candidate: unknown): TodoItem[] | null {
    if (!Array.isArray(candidate)) return null

    const todos: TodoItem[] = []
    candidate.forEach((entry, index) => {
        if (typeof entry === 'string') {
            const content = entry.trim()
            if (!content) return
            todos.push({
                content,
                priority: 'medium',
                status: 'pending',
                id: `plan-${index + 1}`
            })
            return
        }

        if (!isObject(entry)) return
        const content = extractText(entry)
        if (!content) return
        const id = typeof entry.id === 'string' && entry.id.trim()
            ? entry.id.trim()
            : `plan-${index + 1}`
        todos.push({
            content,
            priority: normalizeTodoPriority(entry.priority),
            status: normalizeTodoStatus(entry.status ?? entry.state),
            id
        })
    })

    const parsed = TodosSchema.safeParse(todos)
    return parsed.success ? parsed.data : null
}

function extractTodosFromPlanText(value: unknown): TodoItem[] | null {
    if (typeof value !== 'string') return null

    const listLines = value.split(/\r?\n/).flatMap((line) => {
        const match = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/)
        if (!match?.[2]) return []
        return [{ indent: match[1]?.length ?? 0, content: match[2] }]
    })

    if (listLines.length === 0) return null
    const topLevelIndent = Math.min(...listLines.map((line) => line.indent))
    return normalizePlanEntries(
        listLines
            .filter((line) => line.indent === topLevelIndent)
            .map((line) => line.content)
    )
}

function isPlanExitToolName(value: unknown): boolean {
    return value === 'ExitPlanMode' || value === 'exit_plan_mode'
}

function extractTodosFromClaudeOutput(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'output') return null

    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'assistant') return null

    const message = isObject(data.message) ? data.message : null
    if (!message) return null

    const modelContent = message.content
    if (!Array.isArray(modelContent)) return null

    let planExitSeen = false
    let planText: string | null = null
    for (const block of modelContent) {
        if (!isObject(block)) continue
        if (block.type === 'text' && typeof block.text === 'string') {
            planText ??= block.text
            continue
        }
        if (block.type !== 'tool_use') continue
        const name = typeof block.name === 'string' ? block.name : null
        const input = 'input' in block ? (block as Record<string, unknown>).input : null
        if (name === 'TodoWrite') {
            if (!isObject(input)) continue

            const todosCandidate = input.todos
            const parsed = TodosSchema.safeParse(todosCandidate)
            if (parsed.success) {
                return parsed.data
            }
            continue
        }
        if (isPlanExitToolName(name)) {
            planExitSeen = true
            if (isObject(input) && typeof input.plan === 'string') {
                planText = input.plan
            }
        }
    }

    return planExitSeen ? extractTodosFromPlanText(planText) : null
}

function extractTodosFromCodexMessage(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'codex') return null

    const data = isObject(content.data) ? content.data : null
    if (!data) return null

    if (data.type === 'plan_update') {
        return normalizePlanEntries(data.plan ?? data.update ?? data.items ?? data.steps)
    }

    if (data.type !== 'tool-call') return null

    const name = typeof data.name === 'string' ? data.name : null
    const input = 'input' in data ? (data as Record<string, unknown>).input : null
    if (name === 'update_plan') {
        return normalizePlanEntries(isObject(input) ? input.plan : null)
    }
    if (name === 'TodoWrite') {
        if (!isObject(input)) return null

        const todosCandidate = input.todos
        const parsed = TodosSchema.safeParse(todosCandidate)
        return parsed.success ? parsed.data : null
    }
    if (isPlanExitToolName(name)) {
        return extractTodosFromPlanText(isObject(input) ? input.plan : null)
    }

    return null
}

function extractTodosFromAcpMessage(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'codex') return null

    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'plan') return null

    return normalizePlanEntries(data.entries)
}

export function extractSessionTodosFromMessageContent(messageContent: unknown): TodoItem[] | null {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record) return null

    if (record.role !== 'agent' && record.role !== 'assistant') return null

    if (!isObject(record.content) || typeof record.content.type !== 'string') return null

    return extractTodosFromClaudeOutput(record.content)
        ?? extractTodosFromCodexMessage(record.content)
        ?? extractTodosFromAcpMessage(record.content)
}
