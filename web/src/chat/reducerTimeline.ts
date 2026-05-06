import type { AgentReasoningBlock, AgentTextBlock, ChatBlock, CliOutputBlock, ToolCallBlock, ToolPermission } from '@/chat/types'
import type { TracedMessage } from '@/chat/tracer'
import { createCliOutputBlock, isCliOutputText, mergeCliOutputBlocks } from '@/chat/reducerCliOutput'
import { parseMessageAsEvent } from '@/chat/reducerEvents'
import { ensureToolBlock, extractTitleFromChangeTitleInput, isChangeTitleToolName, type PermissionEntry } from '@/chat/reducerTools'
import { isSubagentToolName } from '@/chat/subagentTool'

export function reduceTimeline(
    messages: TracedMessage[],
    context: {
        permissionsById: Map<string, PermissionEntry>
        groups: Map<string, TracedMessage[]>
        consumedGroupIds: Set<string>
        titleChangesByToolUseId: Map<string, string>
        emittedTitleChangeToolUseIds: Set<string>
    }
): { blocks: ChatBlock[]; toolBlocksById: Map<string, ToolCallBlock>; hasReadyEvent: boolean } {
    const blocks: ChatBlock[] = []
    const toolBlocksById = new Map<string, ToolCallBlock>()
    let hasReadyEvent = false

    // Pre-scan: collect UUIDs of system-injected user turns (sidechain
    // prompts, task notifications, system reminders).  These are used below
    // to identify sentinel auto-replies ("No response requested.") whose
    // parentUUID points to one of these injected messages.
    const injectedTurnUuids = new Set<string>()
    for (const msg of messages) {
        if (msg.role !== 'agent' || !msg.isSidechain) continue
        for (const c of msg.content) {
            if (c.type === 'sidechain') {
                injectedTurnUuids.add(c.uuid)
            }
        }
    }

    for (const msg of messages) {
        if (msg.role === 'event') {
            if (msg.content.type === 'ready') {
                hasReadyEvent = true
                continue
            }
            if (msg.content.type === 'token-count') {
                continue
            }
            if (msg.content.type === 'turn-duration') {
                const targetId = msg.content.targetMessageId
                const durationMs = msg.content.durationMs as number
                type DurationBearingBlock = AgentTextBlock | AgentReasoningBlock | CliOutputBlock | ToolCallBlock
                const isDurationTarget = (b: ChatBlock): b is DurationBearingBlock =>
                    b.kind === 'agent-text' || b.kind === 'agent-reasoning' || b.kind === 'cli-output' || b.kind === 'tool-call'
                let foundIndex = -1

                if (targetId) {
                    foundIndex = blocks.findLastIndex(b => isDurationTarget(b) && (b.id === targetId || b.id.startsWith(`${targetId}:`)))
                    if (foundIndex === -1) {
                        foundIndex = blocks.findLastIndex(b => b.kind === 'tool-call' && b.tool.id === targetId)
                    }
                }

                if (foundIndex === -1) {
                    foundIndex = blocks.findLastIndex(isDurationTarget)
                }

                if (foundIndex !== -1) {
                    const b = blocks[foundIndex]
                    if (isDurationTarget(b)) {
                        b.durationMs = durationMs
                    }
                }
                continue
            }

            blocks.push({
                kind: 'agent-event',
                id: msg.id,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                model: msg.model,
                event: msg.content,
                meta: msg.meta
            })
            continue
        }

        const event = parseMessageAsEvent(msg)
        if (event) {
            blocks.push({
                kind: 'agent-event',
                id: msg.id,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                model: msg.model,
                event,
                meta: msg.meta
            })
            continue
        }

        if (msg.role === 'user') {
            if (isCliOutputText(msg.content.text, msg.meta)) {
                blocks.push(createCliOutputBlock({
                    id: msg.id,
                    localId: msg.localId,
                    createdAt: msg.createdAt,
                    invokedAt: msg.invokedAt,
                    text: msg.content.text,
                    source: 'user',
                    meta: msg.meta
                }))
                continue
            }
            blocks.push({
                kind: 'user-text',
                id: msg.id,
                localId: msg.localId,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                text: msg.content.text,
                attachments: msg.content.attachments,
                status: msg.status,
                originalText: msg.originalText,
                meta: msg.meta
            })
            continue
        }

        if (msg.role === 'agent') {
            // When the message contains a Task/Agent tool_use, Claude often writes
            // the prompt as a text block before the tool_use block.  We only want to
            // suppress that exact prompt text — not every text block in the message.
            const taskToolCall = msg.content.find(
                (c) => c.type === 'tool-call' && isSubagentToolName(c.name)
            )
            const taskPromptText: string | null = (() => {
                if (!taskToolCall || taskToolCall.type !== 'tool-call') return null
                const input = taskToolCall.input
                if (typeof input === 'object' && input !== null && 'prompt' in input) {
                    const p = (input as { prompt: unknown }).prompt
                    if (typeof p === 'string') return p
                }
                return null
            })()

            for (let idx = 0; idx < msg.content.length; idx += 1) {
                const c = msg.content[idx]
                if (c.type === 'text') {
                    // Skip "No response requested." — Claude's sentinel auto-response
                    // to system-injected messages (task notifications, system reminders).
                    //
                    // Structural checks to avoid false positives:
                    //   1. msg.content.length === 1 — no tool calls or reasoning alongside
                    //   2. c.parentUUID points to a known injected turn UUID (collected
                    //      in pre-scan from sidechain content blocks)
                    //   3. Exact text match on the known sentinel phrase
                    if (
                        msg.content.length === 1 &&
                        c.parentUUID !== null &&
                        injectedTurnUuids.has(c.parentUUID)
                    ) {
                        const trimmedText = c.text.trim()
                        if (trimmedText === 'No response requested.' || trimmedText === 'No response requested') {
                            continue
                        }
                    }

                    // Skip text blocks that are just the Task tool prompt (already shown in tool card)
                    if (taskPromptText && c.text.trim() === taskPromptText.trim()) continue

                    if (isCliOutputText(c.text, msg.meta)) {
                        blocks.push(createCliOutputBlock({
                            id: `${msg.id}:${idx}`,
                            localId: msg.localId,
                            createdAt: msg.createdAt,
                            invokedAt: msg.invokedAt,
                            usage: msg.usage,
                            model: msg.model,
                            text: c.text,
                            source: 'assistant',
                            meta: msg.meta
                        }))
                        continue
                    }
                    blocks.push({
                        kind: 'agent-text',
                        id: `${msg.id}:${idx}`,
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        usage: msg.usage,
                        model: msg.model,
                        text: c.text,
                        meta: msg.meta
                    })
                    continue
                }

                if (c.type === 'reasoning') {
                    blocks.push({
                        kind: 'agent-reasoning',
                        id: `${msg.id}:${idx}`,
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        usage: msg.usage,
                        model: msg.model,
                        text: c.text,
                        meta: msg.meta
                    })
                    continue
                }

                if (c.type === 'summary') {
                    blocks.push({
                        kind: 'agent-event',
                        id: `${msg.id}:${idx}`,
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        model: msg.model,
                        event: { type: 'message', message: c.summary },
                        meta: msg.meta
                    })
                    continue
                }

                if (c.type === 'tool-call') {
                    if (isChangeTitleToolName(c.name)) {
                        const title = context.titleChangesByToolUseId.get(c.id) ?? extractTitleFromChangeTitleInput(c.input)
                        if (title && !context.emittedTitleChangeToolUseIds.has(c.id)) {
                            context.emittedTitleChangeToolUseIds.add(c.id)
                            blocks.push({
                                kind: 'agent-event',
                                id: `${msg.id}:${idx}`,
                                createdAt: msg.createdAt,
                                invokedAt: msg.invokedAt,
                                model: msg.model,
                                event: { type: 'title-changed', title },
                                meta: msg.meta
                            })
                        }
                        continue
                    }

                    const permission = context.permissionsById.get(c.id)?.permission

                    const block = ensureToolBlock(blocks, toolBlocksById, c.id, {
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        usage: msg.usage,
                        model: msg.model,
                        localId: msg.localId,
                        meta: msg.meta,
                        name: c.name,
                        input: c.input,
                        description: c.description,
                        permission
                    })

                    if (block.tool.state === 'pending') {
                        block.tool.state = 'running'
                        block.tool.startedAt = msg.createdAt
                    }

                    if (isSubagentToolName(c.name) && !context.consumedGroupIds.has(msg.id)) {
                        const sidechain = context.groups.get(msg.id) ?? null
                        if (sidechain && sidechain.length > 0) {
                            context.consumedGroupIds.add(msg.id)
                            const child = reduceTimeline(sidechain, context)
                            hasReadyEvent = hasReadyEvent || child.hasReadyEvent
                            block.children = child.blocks
                        }
                    }
                    continue
                }

                if (c.type === 'tool-result') {
                    const title = context.titleChangesByToolUseId.get(c.tool_use_id) ?? null
                    if (title) {
                        if (!context.emittedTitleChangeToolUseIds.has(c.tool_use_id)) {
                            context.emittedTitleChangeToolUseIds.add(c.tool_use_id)
                            blocks.push({
                                kind: 'agent-event',
                                id: `${msg.id}:${idx}`,
                                createdAt: msg.createdAt,
                                invokedAt: msg.invokedAt,
                                model: msg.model,
                                event: { type: 'title-changed', title },
                                meta: msg.meta
                            })
                        }
                        continue
                    }

                    const permissionEntry = context.permissionsById.get(c.tool_use_id)
                    const permissionFromResult = c.permissions ? ({
                        id: c.tool_use_id,
                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                        date: c.permissions.date,
                        mode: c.permissions.mode,
                        allowedTools: c.permissions.allowedTools,
                        decision: c.permissions.decision
                    } satisfies ToolPermission) : undefined

                    const permission = (() => {
                        if (permissionFromResult && permissionEntry?.permission) {
                            return {
                                ...permissionEntry.permission,
                                ...permissionFromResult,
                                allowedTools: permissionFromResult.allowedTools ?? permissionEntry.permission.allowedTools,
                                decision: permissionFromResult.decision ?? permissionEntry.permission.decision
                            } satisfies ToolPermission
                        }
                        return permissionFromResult ?? permissionEntry?.permission
                    })()

                    const block = ensureToolBlock(blocks, toolBlocksById, c.tool_use_id, {
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        usage: msg.usage,
                        model: msg.model,
                        localId: msg.localId,
                        meta: msg.meta,
                        name: permissionEntry?.toolName ?? 'Tool',
                        input: permissionEntry?.input ?? null,
                        description: null,
                        permission
                    })

                    block.tool.result = c.content
                    block.tool.completedAt = msg.createdAt
                    block.tool.state = c.is_error ? 'error' : 'completed'
                    continue
                }

                if (c.type === 'sidechain') {
                    // Extract task-notification summaries as visible events
                    const trimmedPrompt = c.prompt.trimStart()
                    if (trimmedPrompt.startsWith('<task-notification>')) {
                        const summary = trimmedPrompt.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim()
                        if (summary) {
                            blocks.push({
                                kind: 'agent-event',
                                id: `${msg.id}:${idx}`,
                                createdAt: msg.createdAt,
                                invokedAt: msg.invokedAt,
                                model: msg.model,
                                event: { type: 'message', message: summary },
                                meta: msg.meta
                            })
                        }
                    }
                    // Skip rendering prompt text (already in parent Task tool card or not user-visible)
                    continue
                }
            }
        }
    }

    return { blocks: mergeCliOutputBlocks(blocks), toolBlocksById, hasReadyEvent }
}
