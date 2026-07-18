import type { AttachmentMetadata, MessageStatus } from '@/types/api'
import type { ThreadGoal } from '@/types/api'

export type UsageData = {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    context_tokens?: number
    context_window?: number
    thread_id?: string
    scope_role?: string
    service_tier?: string
}

export type AgentEvent =
    | { type: 'switch'; mode: 'local' | 'remote' }
    | { type: 'message'; message: string }
    | { type: 'error'; message: string }
    | { type: 'title-changed'; title: string }
    | { type: 'limit-reached'; endsAt: number; limitType: string }
    | { type: 'limit-warning'; /** 0–1 ratio (e.g. 0.9 = 90%), integer-precision via CLI pipe format */ utilization: number; endsAt: number; limitType: string }
    | { type: 'ready' }
    | { type: 'api-error'; retryAttempt: number; maxRetries: number; error: unknown }
    | { type: 'turn-duration'; durationMs: number; targetMessageId?: string }
    | { type: 'microcompact'; trigger: string; preTokens: number; tokensSaved: number }
    | { type: 'compact'; trigger: string; preTokens: number }
    // Claude Code's automatic away-summary recap (TUI window blur 5min+, then
    // focus). Distinct from the manual `/recap` slash command, which HAPI
    // already renders as a regular assistant bubble.
    | { type: 'recap'; text: string }
    | { type: 'thread-goal-updated'; goal: ThreadGoal; threadId?: string; turnId?: string }
    | { type: 'thread-goal-cleared'; threadId?: string }
    | { type: 'abort-restore'; text: string }
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

export type GeneratedImageContent = {
    type: 'generated-image'
    imageId: string
    fileName: string
    mimeType: string | null
    uuid: string
    parentUUID: string | null
}

export type CodexReviewFinding = {
    title: string
    body: string
    priority: number | null
    confidenceScore: number | null
    filePath: string | null
    lineStart: number | null
    lineEnd: number | null
}

export type CodexReview = {
    findings: CodexReviewFinding[]
    overallCorrectness: string | null
    overallExplanation: string | null
    overallConfidenceScore: number | null
}

export type NormalizedAgentContent =
    | {
        type: 'text'
        text: string
        uuid: string
        parentUUID: string | null
    }
    | {
        type: 'reasoning'
        text: string
        uuid: string
        streamId?: string
        parentUUID: string | null
    }
    | ToolUse
    | ToolResult
    | GeneratedImageContent
    | {
        type: 'codex-review'
        review: CodexReview
        uuid: string
        parentUUID: string | null
    }
    | { type: 'summary'; summary: string }
    | { type: 'sidechain'; uuid: string; parentUUID: string | null; prompt: string }

export type NormalizedMessage = ({
    role: 'user'
    content: { type: 'text'; text: string; attachments?: AttachmentMetadata[] }
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
    invokedAt?: number | null
    model?: string | null
    /**
     * Execution-machine wall clock (epoch ms) parsed from the Claude entry's
     * own `timestamp` field (see `parseAgentTimestampMs`), as opposed to
     * `createdAt` which is when the hub received the message. Null when the
     * source entry has no parseable timestamp (e.g. non-Claude agent
     * flavors) — consumers should fall back to `createdAt` in that case.
     */
    agentTimestamp?: number | null
}

export type ToolPermission = {
    id: string
    status: 'pending' | 'approved' | 'denied' | 'canceled'
    reason?: string
    mode?: string
    allowedTools?: string[]
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>
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
    /**
     * Execution-machine timestamps (from `NormalizedMessage.agentTimestamp`)
     * for the tool_use/tool_result entries, when available. Kept separate
     * from `startedAt`/`completedAt` (rather than replacing them) because the
     * running-state live timer (`ElapsedView`) reads `startedAt` directly —
     * swapping that to the execution machine's clock would expose it to
     * viewer/execution-machine clock skew. `toolDurationMs` prefers these
     * fields for *completed* tool duration only; null when the source Claude
     * entry had no parseable timestamp (e.g. non-Claude agent flavors).
     */
    execStartedAt: number | null
    execCompletedAt: number | null
    description: string | null
    result?: unknown
    permission?: ToolPermission
}

export type UserTextBlock = {
    kind: 'user-text'
    id: string
    localId: string | null
    createdAt: number
    invokedAt?: number | null
    text: string
    attachments?: AttachmentMetadata[]
    status?: MessageStatus
    originalText?: string
    meta?: unknown
}

export type AgentTextBlock = {
    kind: 'agent-text'
    id: string
    localId: string | null
    createdAt: number
    invokedAt?: number | null
    durationMs?: number
    usage?: UsageData
    model?: string | null
    text: string
    meta?: unknown
}

export type AgentReasoningBlock = {
    kind: 'agent-reasoning'
    id: string
    localId: string | null
    createdAt: number
    invokedAt?: number | null
    durationMs?: number
    usage?: UsageData
    model?: string | null
    text: string
    meta?: unknown
}

export type CodexReviewBlock = {
    kind: 'codex-review'
    id: string
    localId: string | null
    createdAt: number
    invokedAt?: number | null
    durationMs?: number
    usage?: UsageData
    model?: string | null
    review: CodexReview
    meta?: unknown
}

export type CliOutputBlock = {
    kind: 'cli-output'
    id: string
    localId: string | null
    createdAt: number
    invokedAt?: number | null
    durationMs?: number
    usage?: UsageData
    model?: string | null
    text: string
    source: 'user' | 'assistant'
    meta?: unknown
}

export type GeneratedImageBlock = {
    kind: 'generated-image'
    id: string
    localId: string | null
    createdAt: number
    invokedAt?: number | null
    imageId: string
    fileName: string
    mimeType: string | null
    meta?: unknown
}

export type AgentEventBlock = {
    kind: 'agent-event'
    id: string
    createdAt: number
    invokedAt?: number | null
    model?: string | null
    event: AgentEvent
    meta?: unknown
}

export type ToolCallBlock = {
    kind: 'tool-call'
    id: string
    localId: string | null
    createdAt: number
    invokedAt?: number | null
    durationMs?: number
    usage?: UsageData
    model?: string | null
    tool: ChatToolCall
    children: ChatBlock[]
    meta?: unknown
}

export type ChatBlock = UserTextBlock | AgentTextBlock | AgentReasoningBlock | CodexReviewBlock | CliOutputBlock | ToolCallBlock | GeneratedImageBlock | AgentEventBlock
