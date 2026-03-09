import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { TeamState } from '@hapi/protocol/types'

type TeamStateDelta = Partial<TeamState> & { _action?: 'create' | 'delete' | 'update' }

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

    // Codex format: { type: 'codex', data: { type: 'tool-call', name: '...', input: {...} } }
    if (content.type === 'codex') {
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

/**
 * Process Agent tool call - the primary tool for spawning teammates in Claude Code.
 * Also handles the legacy Task tool with team_name parameter.
 */
function processAgentSpawn(input: Record<string, unknown>): TeamStateDelta | null {
    const name = typeof input.name === 'string' ? input.name : null
    const description = typeof input.description === 'string' ? input.description : null

    // Agent tool: always creates a member. team_name is optional (uses current team context).
    // Task tool: requires team_name to be treated as a team spawn.
    if (!name) return null

    const agentType = typeof input.subagent_type === 'string' ? input.subagent_type : undefined
    const runInBackground = input.run_in_background === true ? true : undefined
    const isolation = input.isolation === 'worktree' ? 'worktree' as const : undefined

    const delta: TeamStateDelta = {
        _action: 'update',
        members: [{
            name,
            agentType,
            status: 'active',
            runInBackground,
            isolation,
            description: description ?? undefined
        }],
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

function processTaskCreate(input: Record<string, unknown>): TeamStateDelta | null {
    const id = typeof input.task_id === 'string' ? input.task_id
        : typeof input.id === 'string' ? input.id
        : null
    const title = typeof input.title === 'string' ? input.title
        : typeof input.content === 'string' ? input.content
        : null
    if (!id || !title) return null

    const description = typeof input.description === 'string' ? input.description : undefined
    const status = typeof input.status === 'string' ? input.status as 'pending' | 'in_progress' | 'completed' | 'blocked' : 'pending'
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

    const task: Record<string, unknown> = { id }
    if (typeof input.title === 'string') task.title = input.title
    if (typeof input.status === 'string') task.status = input.status
    if (typeof input.owner === 'string') task.owner = input.owner
    if (typeof input.description === 'string') task.description = input.description

    // Must have at least one field besides id
    if (Object.keys(task).length <= 1) return null

    return {
        _action: 'update',
        tasks: [task as { id: string; title: string; status?: 'pending' | 'in_progress' | 'completed' | 'blocked'; owner?: string }],
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

    // If shutdown_request, mark member as shutdown
    if (msgType === 'shutdown_request' && recipient) {
        delta.members = [{ name: recipient, status: 'shutdown' }]
    }

    return delta
}

function extractTeammateMessageText(record: { role: string; content: unknown }): string | null {
    // Direct user message: { role: 'user', content: '<teammate-message>...' | { type: 'text', text: '...' } }
    if (record.role === 'user') {
        if (typeof record.content === 'string') return record.content
        if (isObject(record.content) && record.content.type === 'text' && typeof record.content.text === 'string') {
            return record.content.text
        }
    }

    // Agent-wrapped (isSidechain/isMeta): { role: 'agent', content: { type: 'output', data: { type: 'user', message: { content: '...' } } } }
    if (record.role === 'agent' && isObject(record.content) && record.content.type === 'output') {
        const data = isObject(record.content.data) ? record.content.data : null
        if (data && data.type === 'user' && isObject(data.message) && typeof data.message.content === 'string') {
            return data.message.content
        }
    }

    return null
}

function extractTeammateMessage(record: { role: string; content: unknown }): TeamStateDelta | null {
    const text = extractTeammateMessageText(record)
    if (!text || !text.includes('<teammate-message')) return null

    // Extract teammate_id and content from <teammate-message> tags
    const tagMatch = text.match(/<teammate-message\s+[^>]*teammate_id="([^"]+)"[^>]*>([\s\S]*?)<\/teammate-message>/)
    if (!tagMatch) return null

    const memberId = tagMatch[1]
    const body = tagMatch[2].trim()
    const now = Date.now()

    // Try to parse as JSON (structured protocol messages)
    let parsed: Record<string, unknown> | null = null
    try {
        parsed = JSON.parse(body) as Record<string, unknown>
    } catch {
        // Not JSON — plain text output from teammate
    }

    if (parsed) {
        // permission_request
        if (parsed.type === 'permission_request') {
            const requestId = typeof parsed.request_id === 'string' ? parsed.request_id : null
            const toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : null
            if (!requestId || !toolName) return null

            return {
                _action: 'update',
                pendingPermissions: [{
                    requestId,
                    memberName: memberId,
                    toolName,
                    description: typeof parsed.description === 'string' ? parsed.description : undefined,
                    input: parsed.input,
                    createdAt: now,
                    status: 'pending'
                }],
                updatedAt: now
            }
        }

        // idle_notification — update member status
        if (parsed.type === 'idle_notification') {
            return {
                _action: 'update',
                members: [{
                    name: memberId,
                    status: 'idle'
                }],
                updatedAt: now
            }
        }

        // Other structured messages — store summary as lastOutput
        const summary = typeof parsed.summary === 'string' ? parsed.summary
            : typeof parsed.content === 'string' ? parsed.content
            : null
        if (summary) {
            return {
                _action: 'update',
                members: [{
                    name: memberId,
                    lastOutput: summary.length > 500 ? summary.slice(0, 500) : summary,
                    lastOutputAt: now
                }],
                updatedAt: now
            }
        }

        return null
    }

    // Plain text/markdown output from teammate — store as lastOutput
    return {
        _action: 'update',
        members: [{
            name: memberId,
            lastOutput: body.length > 500 ? body.slice(0, 500) : body,
            lastOutputAt: now
        }],
        updatedAt: now
    }
}

export function extractTeamStateFromMessageContent(messageContent: unknown): TeamStateDelta | null {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record) return null

    // Check for teammate messages (permissions, output, idle, etc.)
    const teammateDelta = extractTeammateMessage(record)
    if (teammateDelta) return teammateDelta

    if (record.role !== 'agent' && record.role !== 'assistant') return null
    if (!isObject(record.content) || typeof record.content.type !== 'string') return null

    const blocks = extractToolBlocks(record.content)
    if (blocks.length === 0) return null

    let result: TeamStateDelta | null = null

    for (const block of blocks) {
        let delta: TeamStateDelta | null = null

        switch (block.name) {
            case 'TeamCreate':
                delta = processTeamCreate(block.input)
                break
            case 'TeamDelete':
                delta = processTeamDelete()
                break
            case 'Agent':
                delta = processAgentSpawn(block.input)
                break
            case 'Task': {
                // Legacy: Task tool with team_name is treated as agent spawn
                const teamName = typeof block.input.team_name === 'string' ? block.input.team_name : null
                if (teamName) {
                    delta = processAgentSpawn(block.input)
                }
                break
            }
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

    if (incoming.members) {
        merged.members = [...(merged.members ?? []), ...incoming.members]
    }
    if (incoming.tasks) {
        merged.tasks = [...(merged.tasks ?? []), ...incoming.tasks]
    }
    if (incoming.messages) {
        merged.messages = [...(merged.messages ?? []), ...incoming.messages]
    }
    if (incoming.pendingPermissions) {
        merged.pendingPermissions = [...(merged.pendingPermissions ?? []), ...incoming.pendingPermissions]
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

    // update: merge into existing
    if (!existing) return null

    const updated = { ...existing }

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
                taskMap.set(task.id, task)
            }
        }
        updated.tasks = Array.from(taskMap.values())
    }

    if (delta.messages) {
        const msgs = updated.messages ?? []
        updated.messages = [...msgs, ...delta.messages].slice(-50)
    }

    if (delta.pendingPermissions) {
        const permMap = new Map((updated.pendingPermissions ?? []).map(p => [p.requestId, p]))
        for (const perm of delta.pendingPermissions) {
            permMap.set(perm.requestId, perm)
        }
        updated.pendingPermissions = Array.from(permMap.values())
    }

    if (delta.updatedAt) {
        updated.updatedAt = delta.updatedAt
    }

    return updated
}
