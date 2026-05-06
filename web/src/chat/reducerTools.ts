import type { AgentState } from '@/types/api'
import type { ChatBlock, ChatToolCall, NormalizedMessage, ToolCallBlock, ToolPermission, UsageData } from '@/chat/types'

export type PermissionEntry = {
    toolName: string
    input: unknown
    permission: ToolPermission
}

export function getPermissions(agentState: AgentState | null | undefined): Map<string, PermissionEntry> {
    const map = new Map<string, PermissionEntry>()

    const completed = agentState?.completedRequests ?? null
    if (completed) {
        for (const [id, entry] of Object.entries(completed)) {
            map.set(id, {
                toolName: entry.tool,
                input: entry.arguments,
                permission: {
                    id,
                    status: entry.status,
                    reason: entry.reason ?? undefined,
                    mode: entry.mode ?? undefined,
                    decision: entry.decision ?? undefined,
                    allowedTools: entry.allowTools,
                    answers: entry.answers,
                    createdAt: entry.createdAt ?? null,
                    completedAt: entry.completedAt ?? null
                }
            })
        }
    }

    const requests = agentState?.requests ?? null
    if (requests) {
        for (const [id, request] of Object.entries(requests)) {
            if (map.has(id)) continue
            map.set(id, {
                toolName: request.tool,
                input: request.arguments,
                permission: {
                    id,
                    status: 'pending',
                    createdAt: request.createdAt ?? null
                }
            })
        }
    }

    return map
}

export function ensureToolBlock(
    blocks: ChatBlock[],
    toolBlocksById: Map<string, ToolCallBlock>,
    id: string,
    seed: {
        createdAt: number
        invokedAt?: number | null
        durationMs?: number
        usage?: UsageData
        model?: string | null
        localId: string | null
        meta?: unknown
        name: string
        input: unknown
        description: string | null
        permission?: ToolPermission
    }
): ToolCallBlock {
    const existing = toolBlocksById.get(id)
    if (existing) {
        const isPlaceholderToolName = (name: string): boolean => {
            const normalized = name.trim().toLowerCase()
            return normalized === '' || normalized === 'tool' || normalized === 'unknown'
        }

        // Preserve earliest createdAt for stable ordering.
        if (seed.createdAt < existing.createdAt) {
            existing.createdAt = seed.createdAt
            existing.tool.createdAt = seed.createdAt
        }
        if (seed.permission) {
            existing.tool.permission = { ...existing.tool.permission, ...seed.permission }
            if (existing.tool.state === 'running' && seed.permission.status === 'pending') {
                existing.tool.state = 'pending'
            }
        }
        if (seed.name && (!isPlaceholderToolName(seed.name) || isPlaceholderToolName(existing.tool.name))) {
            existing.tool.name = seed.name
        }
        if (seed.input !== null && seed.input !== undefined) {
            existing.tool.input = seed.input
        }
        if (seed.description !== null) {
            existing.tool.description = seed.description
        }
        // The first call (tool_use) records when the tool was invoked. The
        // second call (tool_result) carries the result message's invokedAt,
        // which is when the result was processed — not when the tool was
        // invoked. Preserve the original timestamp so the metadata footer
        // still answers "when was this tool invoked?" correctly.
        if (seed.invokedAt !== undefined && existing.invokedAt == null) {
            existing.invokedAt = seed.invokedAt
        }
        if (seed.durationMs !== undefined) {
            existing.durationMs = seed.durationMs
        }
        if (seed.usage !== undefined) {
            existing.usage = seed.usage
        }
        if (seed.model !== undefined) {
            existing.model = seed.model
        }
        return existing
    }

    const initialState: ChatToolCall['state'] = seed.permission?.status === 'pending'
        ? 'pending'
        : seed.permission?.status === 'denied' || seed.permission?.status === 'canceled'
            ? 'error'
            : 'running'

    const tool: ChatToolCall = {
        id,
        name: seed.name,
        state: initialState,
        input: seed.input,
        createdAt: seed.createdAt,
        startedAt: initialState === 'running' ? seed.createdAt : null,
        completedAt: null,
        description: seed.description,
        permission: seed.permission
    }

    const block: ToolCallBlock = {
        kind: 'tool-call',
        id,
        localId: seed.localId,
        createdAt: seed.createdAt,
        invokedAt: seed.invokedAt,
        durationMs: seed.durationMs,
        usage: seed.usage,
        model: seed.model,
        tool,
        children: [],
        meta: seed.meta
    }

    toolBlocksById.set(id, block)
    blocks.push(block)
    return block
}

export function collectToolIdsFromMessages(messages: NormalizedMessage[]): Set<string> {
    const ids = new Set<string>()
    for (const msg of messages) {
        if (msg.role !== 'agent') continue
        for (const content of msg.content) {
            if (content.type === 'tool-call') {
                ids.add(content.id)
            } else if (content.type === 'tool-result') {
                ids.add(content.tool_use_id)
            }
        }
    }
    return ids
}

export function isChangeTitleToolName(name: string): boolean {
    return name === 'mcp__hapi__change_title' || name === 'hapi__change_title'
}

export function extractTitleFromChangeTitleInput(input: unknown): string | null {
    if (!input || typeof input !== 'object') return null
    const title = (input as { title?: unknown }).title
    return typeof title === 'string' && title.trim().length > 0 ? title.trim() : null
}

export function collectTitleChanges(messages: NormalizedMessage[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const msg of messages) {
        if (msg.role !== 'agent') continue
        for (const content of msg.content) {
            if (content.type !== 'tool-call') continue
            if (!isChangeTitleToolName(content.name)) continue
            const title = extractTitleFromChangeTitleInput(content.input)
            if (!title) continue
            map.set(content.id, title)
        }
    }
    return map
}
