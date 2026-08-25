import type { AttachmentMetadata } from '@/types/api'
import type { ChatBlock, ChatToolCall, ToolPermission } from '@/chat/types'
import type { LatestUsage } from '@/chat/reducer'
import type { VisibleChatBlock } from '@/chat/toolGroups'

/**
 * Normative projection of the web chat pipeline output.
 *
 * Native clients (iOS/Android) must reproduce exactly the fields kept here;
 * everything else on the web ChatBlock shapes is web-presentation or advisory
 * detail they are free to diverge on. The authoritative field list lives in
 * shared/fixtures/README.md — keep both in sync.
 *
 * Principle: structure + semantics in, web-presentation out.
 */
export type JsonObject = Record<string, unknown>

function withOptional(target: JsonObject, key: string, value: unknown): void {
    if (value !== undefined) {
        target[key] = value
    }
}

function projectAttachments(attachments: AttachmentMetadata[] | undefined): JsonObject[] | undefined {
    if (!attachments || attachments.length === 0) return undefined
    // previewUrl is a web-serving convenience — dropped.
    return attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        path: attachment.path
    }))
}

function projectPermission(permission: ToolPermission | undefined): JsonObject | undefined {
    if (!permission) return undefined
    // Dropped: id (duplicates the tool id), date/createdAt/completedAt (timing).
    const projected: JsonObject = { status: permission.status }
    withOptional(projected, 'mode', permission.mode)
    withOptional(projected, 'decision', permission.decision)
    withOptional(projected, 'allowedTools', permission.allowedTools)
    withOptional(projected, 'answers', permission.answers)
    withOptional(projected, 'reason', permission.reason)
    return projected
}

function projectTool(tool: ChatToolCall): JsonObject {
    // Dropped: createdAt/startedAt/completedAt/execStartedAt/execCompletedAt
    // (timing), description/nativeTitle/nativeKind (presentation), progress
    // (live-stream advisory; a stored snapshot may surface it via `result`).
    const projected: JsonObject = {
        id: tool.id,
        name: tool.name,
        state: tool.state
    }
    withOptional(projected, 'input', tool.input)
    withOptional(projected, 'result', tool.result)
    withOptional(projected, 'permission', projectPermission(tool.permission))
    return projected
}

function projectBlockBase(block: { kind: string; id: string; createdAt: number; invokedAt?: number | null }): JsonObject {
    const projected: JsonObject = {
        kind: block.kind,
        id: block.id,
        createdAt: block.createdAt
    }
    if (block.invokedAt !== undefined && block.invokedAt !== null) {
        projected.invokedAt = block.invokedAt
    }
    return projected
}

/**
 * Project one reduced ChatBlock down to its normative fields.
 * Dropped on every kind: meta, usage, model, durationMs, status, originalText.
 */
export function projectChatBlock(block: ChatBlock): JsonObject {
    const projected = projectBlockBase(block)
    switch (block.kind) {
        case 'user-text':
            projected.localId = block.localId
            projected.text = block.text
            withOptional(projected, 'attachments', projectAttachments(block.attachments))
            return projected
        case 'agent-text':
        case 'agent-reasoning':
            projected.localId = block.localId
            projected.text = block.text
            return projected
        case 'cli-output':
            projected.localId = block.localId
            projected.text = block.text
            projected.source = block.source
            return projected
        case 'codex-review':
            projected.localId = block.localId
            projected.review = block.review
            return projected
        case 'generated-image':
            // `source` (inline media bytes/URL resolution) is a web rendering
            // concern — natives fetch by imageId.
            projected.localId = block.localId
            projected.imageId = block.imageId
            projected.fileName = block.fileName
            projected.mimeType = block.mimeType
            return projected
        case 'agent-event':
            // Normalized AgentEvent objects are wire-semantic by construction:
            // carried verbatim (type + typed payload fields).
            projected.event = block.event
            return projected
        case 'tool-call':
            projected.localId = block.localId
            projected.tool = projectTool(block.tool)
            if (block.children.length > 0) {
                projected.children = block.children.map(projectChatBlock)
            }
            return projected
    }
}

/**
 * Project a visible block (post tool-grouping). Tool groups keep membership,
 * order and boundary ids; presentation state (defaultOpen, historyState,
 * needsOlderHistory, activityTitle, presentationMode, summary) is dropped.
 */
export function projectVisibleChatBlock(block: VisibleChatBlock): JsonObject {
    if (block.kind !== 'tool-group') {
        return projectChatBlock(block)
    }
    const projected = projectBlockBase(block)
    projected.firstToolId = block.firstToolId
    projected.lastToolId = block.lastToolId
    projected.tools = block.tools.map(projectChatBlock)
    return projected
}

/**
 * Normative usage projection. Dropped: cacheCreation/cacheRead (display
 * detail already folded into contextSize), model (advisory heuristic input),
 * timestamp (timing).
 */
export function projectLatestUsage(usage: LatestUsage | null): JsonObject | null {
    if (!usage) return null
    return {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        contextSize: usage.contextSize,
        contextWindow: usage.contextWindow
    }
}
