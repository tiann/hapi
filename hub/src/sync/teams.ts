import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { TeamState, TeamTask } from '@hapi/protocol/types'

type TeamTaskDelta = {
    id: string
    title?: string
    description?: string
    status?: TeamTask['status']
    owner?: string
}

type TeamStateDelta = Omit<Partial<TeamState>, 'tasks'> & {
    _action?: 'create' | 'delete' | 'update' | 'ensure'
    tasks?: TeamTaskDelta[]
}

const CODEX_SUBAGENT_TEAM_NAME = 'Codex subagents'
const CODEX_SUBAGENT_TASK_PREFIX = 'codex-subagent:'
const TEAM_TASK_STATUSES = new Set<NonNullable<TeamTask['status']>>([
    'pending',
    'in_progress',
    'completed',
    'blocked'
])

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function asStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null
    const strings = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    return strings.length > 0 ? strings : null
}

function asTaskStatus(value: unknown): TeamTask['status'] | undefined {
    return typeof value === 'string' && TEAM_TASK_STATUSES.has(value as NonNullable<TeamTask['status']>)
        ? value as TeamTask['status']
        : undefined
}

function normalizeToolName(name: string): string {
    return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
}

function shortId(id: string): string {
    return id.length > 12 ? id.slice(0, 8) : id
}

function truncateOneLine(value: string, limit = 120): string {
    const compact = value.replace(/\s+/g, ' ').trim()
    if (compact.length <= limit) return compact
    return `${compact.slice(0, Math.max(0, limit - 1))}…`
}

function codexSubagentTaskId(agentId: string): string {
    return `${CODEX_SUBAGENT_TASK_PREFIX}${agentId}`
}

function codexSubagentTaskTitle(agentId: string, input?: Record<string, unknown>): string {
    const prompt = input
        ? asString(input.message ?? input.prompt ?? input.description)
        : null
    return prompt ? truncateOneLine(prompt) : `Codex subagent ${shortId(agentId)}`
}

function codexAgentType(input: Record<string, unknown>): string | undefined {
    const nickname = asString(input.nickname ?? input.name)
    const agentType = asString(input.agent_type ?? input.agentType)
    if (nickname && agentType) return `${nickname} (${agentType})`
    return nickname ?? agentType ?? undefined
}

function getCodexAgentId(input: Record<string, unknown>): string | null {
    return asString(input.agent_id ?? input.agentId ?? input.id)
}

function extractToolBlocks(content: Record<string, unknown>): Array<{ name: string; input: Record<string, unknown> }> {
    const blocks: Array<{ name: string; input: Record<string, unknown> }> = []

    // Claude output format: { type: 'output', data: { type: 'assistant', message: { content: [...] } } }
    if (content.type === 'output') {
        const data = isObject(content.data) ? content.data : null
        if (!data || data.type !== 'assistant') return blocks

        const message = isObject(data.message) ? data.message : null
        if (!message) return blocks

        const modelContent = message.content
        if (!Array.isArray(modelContent)) return blocks

        for (const block of modelContent) {
            if (!isObject(block) || block.type !== 'tool_use') continue
            const name = typeof block.name === 'string' ? block.name : null
            if (!name) continue
            const input = isObject(block.input) ? block.input as Record<string, unknown> : null
            if (!input) continue
            blocks.push({ name, input })
        }
    }

    // Agent payload format: { type: 'codex', data: { type: 'tool-call', name: '...', input: {...} } }
    if (content.type === AGENT_MESSAGE_PAYLOAD_TYPE) {
        const data = isObject(content.data) ? content.data : null
        if (!data || data.type !== 'tool-call') return blocks
        const name = typeof data.name === 'string' ? data.name : null
        if (!name) return blocks
        const input = isObject(data.input) ? data.input as Record<string, unknown> : null
        if (!input) return blocks
        blocks.push({ name, input })
    }

    return blocks
}

function processTeamCreate(input: Record<string, unknown>): TeamStateDelta | null {
    const teamName = typeof input.team_name === 'string' ? input.team_name : null
    if (!teamName) return null

    return {
        _action: 'create',
        teamName,
        description: typeof input.description === 'string' ? input.description : undefined,
        members: [],
        tasks: [],
        messages: [],
        updatedAt: Date.now()
    }
}

function processTeamDelete(): TeamStateDelta {
    return { _action: 'delete' }
}

function processTaskToolWithTeam(input: Record<string, unknown>): TeamStateDelta | null {
    const teamName = typeof input.team_name === 'string' ? input.team_name : null
    const name = typeof input.name === 'string' ? input.name : null
    if (!teamName || !name) return null

    const agentType = typeof input.subagent_type === 'string' ? input.subagent_type : undefined
    const description = typeof input.description === 'string' ? input.description : null

    const delta: TeamStateDelta = {
        _action: 'update',
        members: [{ name, agentType, status: 'active' }],
        updatedAt: Date.now()
    }

    // Also track the spawned agent's work as a task
    if (description) {
        delta.tasks = [{
            id: `agent:${name}`,
            title: description,
            status: 'in_progress',
            owner: name
        }]
    }

    return delta
}

function processCodexSpawnAgent(input: Record<string, unknown>): TeamStateDelta | null {
    const agentId = getCodexAgentId(input)
    if (!agentId) return null

    const title = codexSubagentTaskTitle(agentId, input)

    return {
        _action: 'ensure',
        teamName: CODEX_SUBAGENT_TEAM_NAME,
        description: 'Codex multi_agent_v1 subagents observed through HAPI',
        members: [{
            name: agentId,
            agentType: codexAgentType(input),
            status: 'active'
        }],
        tasks: [{
            id: codexSubagentTaskId(agentId),
            title,
            description: title,
            status: 'in_progress',
            owner: agentId
        }],
        updatedAt: Date.now()
    }
}

function processCodexWaitAgent(input: Record<string, unknown>): TeamStateDelta | null {
    const status = isObject(input.status) ? input.status as Record<string, unknown> : null
    const target = asString(input.target ?? input.agent_id ?? input.agentId)
    const targets = asStringArray(input.targets ?? input.agent_ids ?? input.agentIds)
    const agentIds = new Set<string>()
    if (target) agentIds.add(target)
    for (const id of targets ?? []) {
        agentIds.add(id)
    }
    if (status) {
        for (const id of Object.keys(status)) {
            agentIds.add(id)
        }
    }
    if (agentIds.size === 0) return null

    const members = Array.from(agentIds, (agentId) => {
        const statusEntry = status && isObject(status[agentId]) ? status[agentId] as Record<string, unknown> : null
        const completed = Boolean(statusEntry?.completed)
            || statusEntry?.status === 'completed'
            || input.completed === true
        return {
            name: agentId,
            status: completed ? 'idle' as const : 'active' as const
        }
    })

    const tasks = Array.from(agentIds, (agentId) => {
        const statusEntry = status && isObject(status[agentId]) ? status[agentId] as Record<string, unknown> : null
        const completed = Boolean(statusEntry?.completed)
            || statusEntry?.status === 'completed'
            || input.completed === true
        return {
            id: codexSubagentTaskId(agentId),
            status: completed ? 'completed' as const : 'in_progress' as const,
            owner: agentId
        }
    })

    return {
        _action: 'update',
        members,
        tasks,
        updatedAt: Date.now()
    }
}

function isCompletedPreviousStatus(value: unknown): boolean {
    if (value === 'completed') return true
    if (!isObject(value)) return false
    return Object.prototype.hasOwnProperty.call(value, 'completed')
        || value.status === 'completed'
}

function processCodexCloseAgent(input: Record<string, unknown>): TeamStateDelta | null {
    const target = asString(input.target ?? input.agent_id ?? input.agentId)
    if (!target) return null

    const previousStatus = input.previous_status ?? input.previousStatus
    const hasPreviousStatus = previousStatus !== null && previousStatus !== undefined
    const taskStatus = !hasPreviousStatus || isCompletedPreviousStatus(previousStatus)
        ? 'completed'
        : 'blocked'

    return {
        _action: 'update',
        members: [{
            name: target,
            status: 'shutdown'
        }],
        tasks: [{
            id: codexSubagentTaskId(target),
            status: taskStatus,
            owner: target
        }],
        updatedAt: Date.now()
    }
}

function processTaskCreate(input: Record<string, unknown>): TeamStateDelta | null {
    const id = typeof input.task_id === 'string' ? input.task_id
        : typeof input.id === 'string' ? input.id
        : null
    const title = typeof input.title === 'string' ? input.title
        : typeof input.content === 'string' ? input.content
        : null
    if (!id || !title) return null

    const description = typeof input.description === 'string' ? input.description : undefined
    const status = asTaskStatus(input.status) ?? 'pending'
    const owner = typeof input.owner === 'string' ? input.owner : undefined

    return {
        _action: 'update',
        tasks: [{ id, title, description, status, owner }],
        updatedAt: Date.now()
    }
}

function processTaskUpdate(input: Record<string, unknown>): TeamStateDelta | null {
    const id = typeof input.task_id === 'string' ? input.task_id
        : typeof input.id === 'string' ? input.id
        : null
    if (!id) return null

    const task: TeamTaskDelta = { id }
    if (typeof input.title === 'string') task.title = input.title
    const status = asTaskStatus(input.status)
    if (status) task.status = status
    if (typeof input.owner === 'string') task.owner = input.owner
    if (typeof input.description === 'string') task.description = input.description

    // Must have at least one field besides id
    if (Object.keys(task).length <= 1) return null

    return {
        _action: 'update',
        tasks: [task],
        updatedAt: Date.now()
    }
}

function processSendMessage(input: Record<string, unknown>): TeamStateDelta | null {
    const type = typeof input.type === 'string' ? input.type : null
    if (!type) return null

    const summary = typeof input.summary === 'string' ? input.summary : ''
    const recipient = typeof input.recipient === 'string' ? input.recipient : 'all'

    const validTypes = ['message', 'broadcast', 'shutdown_request', 'shutdown_response'] as const
    const msgType = validTypes.includes(type as typeof validTypes[number])
        ? type as typeof validTypes[number]
        : 'message'

    const delta: TeamStateDelta = {
        _action: 'update',
        messages: [{
            from: 'team-lead',
            to: msgType === 'broadcast' ? 'all' : recipient,
            summary,
            type: msgType,
            timestamp: Date.now()
        }],
        updatedAt: Date.now()
    }

    // If shutdown_request with approve=true, mark member as shutdown
    if (msgType === 'shutdown_request' && recipient) {
        delta.members = [{ name: recipient, status: 'shutdown' }]
    }

    return delta
}

export function extractTeamStateFromMessageContent(messageContent: unknown): TeamStateDelta | null {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record) return null

    if (record.role !== 'agent' && record.role !== 'assistant') return null
    if (!isObject(record.content) || typeof record.content.type !== 'string') return null

    const blocks = extractToolBlocks(record.content)
    if (blocks.length === 0) return null

    let result: TeamStateDelta | null = null

    for (const block of blocks) {
        let delta: TeamStateDelta | null = null
        const toolName = normalizeToolName(block.name)

        switch (toolName) {
            case 'TeamCreate':
                delta = processTeamCreate(block.input)
                break
            case 'TeamDelete':
                delta = processTeamDelete()
                break
            case 'Task':
                delta = processTaskToolWithTeam(block.input)
                break
            case 'spawn_agent':
                delta = processCodexSpawnAgent(block.input)
                break
            case 'wait_agent':
                delta = processCodexWaitAgent(block.input)
                break
            case 'close_agent':
                delta = processCodexCloseAgent(block.input)
                break
            case 'TaskCreate':
                delta = processTaskCreate(block.input)
                break
            case 'TaskUpdate':
                delta = processTaskUpdate(block.input)
                break
            case 'SendMessage':
                delta = processSendMessage(block.input)
                break
        }

        if (delta) {
            result = result ? mergeDelta(result, delta) : delta
        }
    }

    return result
}

function mergeDelta(base: TeamStateDelta, incoming: TeamStateDelta): TeamStateDelta {
    // delete action overrides everything
    if (incoming._action === 'delete') return incoming
    // create action overrides everything
    if (incoming._action === 'create') return incoming

    const merged = { ...base }
    if (incoming._action === 'ensure' && merged._action !== 'create') {
        merged._action = 'ensure'
    }

    if (incoming.members) {
        merged.members = [...(merged.members ?? []), ...incoming.members]
    }
    if (incoming.tasks) {
        merged.tasks = [...(merged.tasks ?? []), ...incoming.tasks]
    }
    if (incoming.messages) {
        merged.messages = [...(merged.messages ?? []), ...incoming.messages]
    }
    if (incoming.teamName && !merged.teamName) {
        merged.teamName = incoming.teamName
    }
    if (incoming.description && !merged.description) {
        merged.description = incoming.description
    }
    if (incoming.updatedAt) {
        merged.updatedAt = incoming.updatedAt
    }

    return merged
}

export function applyTeamStateDelta(
    existing: TeamState | null | undefined,
    delta: TeamStateDelta
): TeamState | null {
    if (delta._action === 'delete') return null

    if (delta._action === 'create') {
        const { _action: _, ...state } = delta
        return state as TeamState
    }

    // update: merge into existing; ensure creates a lightweight state when
    // Codex emits subagent lifecycle events without a prior TeamCreate tool.
    if (!existing && delta._action !== 'ensure') return null

    const base = existing ?? {
        teamName: delta.teamName ?? CODEX_SUBAGENT_TEAM_NAME,
        description: delta.description,
        members: [],
        tasks: [],
        messages: [],
        updatedAt: delta.updatedAt ?? Date.now()
    }

    const updated = { ...base }

    if (!updated.description && delta.description) {
        updated.description = delta.description
    }

    if (delta.members) {
        const memberMap = new Map((updated.members ?? []).map(m => [m.name, m]))
        for (const member of delta.members) {
            const existing = memberMap.get(member.name)
            if (existing) {
                memberMap.set(member.name, { ...existing, ...member })
            } else {
                memberMap.set(member.name, member)
            }
        }
        updated.members = Array.from(memberMap.values())
    }

    if (delta.tasks) {
        const taskMap = new Map((updated.tasks ?? []).map(t => [t.id, t]))
        for (const task of delta.tasks) {
            const existing = taskMap.get(task.id)
            if (existing) {
                taskMap.set(task.id, { ...existing, ...task })
            } else if (task.title) {
                // Only insert new tasks that have a title (required by schema).
                // Orphan TaskUpdate without title is ignored to prevent schema validation failure.
                taskMap.set(task.id, { ...task, title: task.title })
            }
        }
        updated.tasks = Array.from(taskMap.values())
    }

    if (delta.messages) {
        const msgs = updated.messages ?? []
        updated.messages = [...msgs, ...delta.messages].slice(-50)
    }

    if (delta.updatedAt) {
        updated.updatedAt = delta.updatedAt
    }

    return updated
}
