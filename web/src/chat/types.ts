import type { MessageStatus } from '@/types/api'

export type UsageData = {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: string
}

export type AgentEvent =
    | { type: 'switch'; mode: 'local' | 'remote' }
    | { type: 'message'; message: string }
    | { type: 'title-changed'; title: string }
    | { type: 'limit-reached'; endsAt: number }
    | { type: 'ready' }
    | ({ type: string } & Record<string, unknown>)

export type ToolResultPermission = {
    date: number
    result: 'approved' | 'denied'
    mode?: string
    allowedTools?: string[]
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
}

export type ToolUse = {
    type: 'tool-call'
    id: string
    name: string
    input: unknown
    description: string | null
    uuid: string
    parentUUID: string | null
}

export type ToolResult = {
    type: 'tool-result'
    tool_use_id: string
    content: unknown
    is_error: boolean
    uuid: string
    parentUUID: string | null
    permissions?: ToolResultPermission
}

export type NormalizedAgentContent =
    | {
        type: 'text'
        text: string
        uuid: string
        parentUUID: string | null
    }
    | ToolUse
    | ToolResult
    | { type: 'summary'; summary: string }
    | { type: 'sidechain'; uuid: string; prompt: string }

export type NormalizedMessage = ({
    role: 'user'
    content: { type: 'text'; text: string }
} | {
    role: 'agent'
    content: NormalizedAgentContent[]
} | {
    role: 'event'
    content: AgentEvent
}) & {
    id: string
    localId: string | null
    createdAt: number
    isSidechain: boolean
    meta?: unknown
    usage?: UsageData
    status?: MessageStatus
    originalText?: string
}

export type ToolPermission = {
    id: string
    status: 'pending' | 'approved' | 'denied' | 'canceled'
    reason?: string
    mode?: string
    allowedTools?: string[]
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    date?: number
    createdAt?: number | null
    completedAt?: number | null
}

export type ChatToolCall = {
    id: string
    name: string
    state: 'pending' | 'running' | 'completed' | 'error'
    input: unknown
    createdAt: number
    startedAt: number | null
    completedAt: number | null
    description: string | null
    result?: unknown
    permission?: ToolPermission
}

export type UserTextBlock = {
    kind: 'user-text'
    id: string
    localId: string | null
    createdAt: number
    text: string
    status?: MessageStatus
    originalText?: string
    meta?: unknown
}

export type AgentTextBlock = {
    kind: 'agent-text'
    id: string
    localId: string | null
    createdAt: number
    text: string
    meta?: unknown
}

export type AgentEventBlock = {
    kind: 'agent-event'
    id: string
    createdAt: number
    event: AgentEvent
    meta?: unknown
}

export type ToolCallBlock = {
    kind: 'tool-call'
    id: string
    localId: string | null
    createdAt: number
    tool: ChatToolCall
    children: ChatBlock[]
    meta?: unknown
}

export type ChatBlock = UserTextBlock | AgentTextBlock | ToolCallBlock | AgentEventBlock
