import { useCallback, useMemo } from 'react'
import type { AppendMessage, AttachmentAdapter, ThreadMessageLike } from '@assistant-ui/react'
import { useExternalMessageConverter, useExternalStoreRuntime } from '@assistant-ui/react'
import { safeStringify } from '@hapi/protocol'
import { renderEventLabel } from '@/chat/presentation'
import type { ChatBlock, CliOutputBlock, CodexReview, UsageData } from '@/chat/types'
import type { AgentEvent, ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock, VisibleChatBlock } from '@/chat/toolGroups'
import type { AttachmentMetadata, MessageStatus as HappyMessageStatus, Session } from '@/types/api'

/**
 * Aggregated metadata for a multi-turn response group, surfaced on the
 * group's first visible block so the `@assistant-ui/react` converter
 * preserves it after joining adjacent assistant messages.
 */
export type AggregatedAssistantMeta = {
    usage?: UsageData
    model: string | null
    invokedAt: number | null
    durationMs: undefined
    turnCount: number
}

export type HappyChatMessageMetadata = {
    kind: 'user' | 'assistant' | 'tool' | 'event' | 'cli-output' | 'codex-review'
    status?: HappyMessageStatus
    localId?: string | null
    originalText?: string
    toolCallId?: string
    event?: AgentEvent
    source?: CliOutputBlock['source']
    attachments?: AttachmentMetadata[]
    invokedAt?: number | null
    durationMs?: number
    usage?: UsageData
    model?: string | null
    review?: CodexReview
    /**
     * Distinct turn count when this block carries an aggregated response
     * group footer. Single-turn blocks omit this field so the existing
     * per-message footer is rendered unchanged.
     */
    turnCount?: number
}

function formatCodexReviewText(review: CodexReview): string {
    const lines = ['Codex review']
    if (review.overallCorrectness) {
        lines.push(`Overall: ${review.overallCorrectness}`)
    }
    if (review.overallExplanation) {
        lines.push('', review.overallExplanation)
    }
    if (review.findings.length > 0) {
        lines.push('', 'Findings:')
        for (const finding of review.findings) {
            const priority = finding.priority === null ? '' : `[P${finding.priority}] `
            const location = finding.filePath
                ? ` (${finding.filePath}${finding.lineStart === null ? '' : `:${finding.lineStart}${finding.lineEnd !== null && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ''}`})`
                : ''
            lines.push(`- ${priority}${finding.title}${location}`)
            lines.push(`  ${finding.body}`)
        }
    }
    return lines.join('\n')
}

type VisibleChatBlockRole = 'user' | 'assistant' | 'system'

/**
 * Mirror the role assignment used by `toThreadMessageLike` so response
 * group boundaries (the `@assistant-ui/react` converter joins adjacent
 * assistant-role messages only) stay consistent with what the library
 * actually flushes as one card.
 */
function visibleBlockRole(block: VisibleChatBlock): VisibleChatBlockRole {
    if (block.kind === 'user-text') return 'user'
    if (block.kind === 'agent-event') return 'system'
    if (block.kind === 'cli-output') return block.source === 'user' ? 'user' : 'assistant'
    return 'assistant'
}

type TurnSource = {
    localId: string | null
    invokedAt: number | null
    durationMs: number | undefined
    model: string | null
    usage: UsageData | undefined
    createdAt: number
}

// Return one turn source per claude-SDK message that the visible block
// represents. `tool-group` is a derived view: `buildVisibleChatBlocks` merges
// adjacent eligible tool-calls without checking that they share a turn, so
// each underlying tool-call contributes its own source. Other assistant-role
// kinds map to a single source.
function turnSourcesFromBlock(block: VisibleChatBlock): TurnSource[] {
    if (block.kind === 'tool-group') {
        return block.tools.map((tool) => ({
            localId: tool.localId,
            invokedAt: tool.invokedAt ?? null,
            durationMs: tool.durationMs,
            model: tool.model ?? null,
            usage: tool.usage,
            createdAt: tool.createdAt
        }))
    }
    if (
        block.kind === 'agent-text'
        || block.kind === 'agent-reasoning'
        || block.kind === 'cli-output'
        || block.kind === 'tool-call'
    ) {
        return [{
            localId: block.localId,
            invokedAt: block.invokedAt ?? null,
            durationMs: block.durationMs,
            model: block.model ?? null,
            usage: block.usage,
            createdAt: block.createdAt
        }]
    }
    return []
}

/**
 * Fallback turn key for environments where the CLI does not stamp a
 * non-null `localId` on each turn's blocks (e.g. claude code spawn
 * sessions today). The key combines `(model, usage totals, createdAt)`:
 * the reducer copies `msg.createdAt` onto every derived `ChatBlock`, so
 * blocks from the same SDK message share createdAt and collapse to one
 * turn, while blocks from different SDK messages stay distinct even
 * when their `(model, usage)` happens to coincide. Limitation: two SDK
 * messages stamped at the same wall-clock millisecond would still
 * collide, but the hub stamp resolution makes that vanishingly rare.
 */
function turnFingerprint(
    model: string | null,
    usage: UsageData | undefined,
    createdAt: number
): string {
    if (!usage) return `m=${model ?? ''}|u=|c=${createdAt}`
    return [
        `m=${model ?? ''}`,
        `i=${usage.input_tokens}`,
        `o=${usage.output_tokens}`,
        `cc=${usage.cache_creation_input_tokens ?? ''}`,
        `cr=${usage.cache_read_input_tokens ?? ''}`,
        `t=${usage.service_tier ?? ''}`,
        `c=${createdAt}`
    ].join('|')
}

/**
 * Sum two optional token counters. Returns `undefined` only when both
 * operands are absent; an explicit `0` on either side participates in
 * the sum (so a `0 + 0` total stays `0` instead of collapsing to
 * `undefined` via JavaScript's falsy `||`).
 */
function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
    if (a === undefined && b === undefined) return undefined
    return (a ?? 0) + (b ?? 0)
}

function addUsage(target: UsageData, addend: UsageData): UsageData {
    return {
        input_tokens: target.input_tokens + addend.input_tokens,
        output_tokens: target.output_tokens + addend.output_tokens,
        cache_creation_input_tokens: sumOptional(
            target.cache_creation_input_tokens,
            addend.cache_creation_input_tokens
        ),
        cache_read_input_tokens: sumOptional(
            target.cache_read_input_tokens,
            addend.cache_read_input_tokens
        ),
        // service_tier dedup follows the rule documented in the plan: pick
        // the first turn's tier when the group is mixed. We keep it on the
        // target so downstream label logic sees a stable value.
        service_tier: target.service_tier
    }
}

/**
 * Walk the visible block list, identify response groups (runs of
 * assistant-role blocks separated by user-text / agent-event /
 * user-source cli-output boundaries), and return a map keyed by the
 * id of each group's first visible block whose value is the summed
 * metadata for that group. Only groups spanning two or more distinct
 * turns produce an entry so single-turn cards remain byte-for-byte
 * unchanged at the call site.
 */
export function aggregateResponseGroups(
    blocks: readonly VisibleChatBlock[]
): Map<string, AggregatedAssistantMeta> {
    const aggregates = new Map<string, AggregatedAssistantMeta>()
    let groupFirstBlockId: string | null = null
    // Ordering-based turn dedup: we compare each block's turn key against
    // the immediately previous turn's key. A `Set` of all seen keys would
    // collapse a third turn whose `(model, usage)` fingerprint happens to
    // match a non-adjacent earlier turn — claude code spawn sessions
    // legitimately produce repeated fingerprints when token totals
    // coincide, and merging them under-counts the visible turn count.
    let prevTurnKey: string | null = null
    const seenModels: string[] = []
    let groupInvokedAt: number | null = null
    let groupUsage: UsageData | undefined
    let groupTurnCount = 0

    const flush = () => {
        if (groupFirstBlockId !== null && groupTurnCount >= 2) {
            const joinedModel = seenModels.length > 0 ? seenModels.join(', ') : null
            aggregates.set(groupFirstBlockId, {
                usage: groupUsage,
                model: joinedModel,
                invokedAt: groupInvokedAt,
                durationMs: undefined,
                turnCount: groupTurnCount
            })
        }
        groupFirstBlockId = null
        prevTurnKey = null
        seenModels.length = 0
        groupInvokedAt = null
        groupUsage = undefined
        groupTurnCount = 0
    }

    for (const block of blocks) {
        const role = visibleBlockRole(block)
        if (role !== 'assistant') {
            // Boundary: close the open group, if any.
            flush()
            continue
        }

        if (groupFirstBlockId === null) {
            groupFirstBlockId = block.id
        }

        for (const turn of turnSourcesFromBlock(block)) {
            // Prefer the CLI-stamped `localId` when present. When it is null
            // (today's claude code spawn flow) fall back to a fingerprint
            // built from `(model, usage totals, createdAt)` — see
            // `turnFingerprint` for the createdAt rationale.
            const turnKey = turn.localId !== null
                ? `id:${turn.localId}`
                : `fp:${turnFingerprint(turn.model, turn.usage, turn.createdAt)}`

            // Skip blocks with no turn signal at all (no localId, no usage,
            // no model) so they don't inflate the turn count.
            if (turn.localId === null && !turn.usage && !turn.model) continue

            // Only the immediately previous turn's key dedups — see prevTurnKey
            // comment above. Non-adjacent matches keep their separate counts.
            if (turnKey === prevTurnKey) continue
            prevTurnKey = turnKey

            groupTurnCount += 1
            if (turn.invokedAt != null && (groupInvokedAt === null || turn.invokedAt < groupInvokedAt)) {
                groupInvokedAt = turn.invokedAt
            }
            if (turn.model && !seenModels.includes(turn.model)) {
                seenModels.push(turn.model)
            }
            if (turn.usage) {
                groupUsage = groupUsage ? addUsage(groupUsage, turn.usage) : { ...turn.usage }
            }
        }
    }

    flush()
    return aggregates
}

function toThreadMessageLike(block: VisibleChatBlock): ThreadMessageLike {
    if (block.kind === 'user-text') {
        const messageId = `user:${block.id}`
        return {
            role: 'user',
            id: messageId,
            createdAt: new Date(block.createdAt),
            content: [{ type: 'text', text: block.text }],
            metadata: {
                custom: {
                    kind: 'user',
                    status: block.status,
                    localId: block.localId,
                    originalText: block.originalText,
                    attachments: block.attachments,
                    invokedAt: block.invokedAt
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'agent-text') {
        const messageId = `assistant:${block.id}`
        return {
            role: 'assistant',
            id: messageId,
            createdAt: new Date(block.createdAt),
            content: [{ type: 'text', text: block.text }],
            metadata: {
                custom: {
                    kind: 'assistant',
                    invokedAt: block.invokedAt,
                    durationMs: block.durationMs,
                    usage: block.usage,
                    model: block.model
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'generated-image') {
        return {
            role: 'assistant',
            id: `generated-image:${block.id}`,
            createdAt: new Date(block.createdAt),
            content: [{
                type: 'tool-call',
                toolCallId: block.id,
                toolName: 'GeneratedImage',
                argsText: '',
                artifact: block
            }],
            metadata: {
                custom: {
                    kind: 'tool',
                    toolCallId: block.id,
                    invokedAt: block.invokedAt ?? null
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'agent-reasoning') {
        const messageId = `assistant:${block.id}`
        return {
            role: 'assistant',
            id: messageId,
            createdAt: new Date(block.createdAt),
            content: [{ type: 'reasoning', text: block.text }],
            metadata: {
                custom: {
                    kind: 'assistant',
                    invokedAt: block.invokedAt,
                    durationMs: block.durationMs,
                    usage: block.usage,
                    model: block.model
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'codex-review') {
        const messageId = `review:${block.id}`
        return {
            role: 'assistant',
            id: messageId,
            createdAt: new Date(block.createdAt),
            content: [{ type: 'text', text: formatCodexReviewText(block.review) }],
            metadata: {
                custom: {
                    kind: 'codex-review',
                    invokedAt: block.invokedAt,
                    durationMs: block.durationMs,
                    usage: block.usage,
                    model: block.model,
                    review: block.review
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'agent-event') {
        const messageId = `event:${block.id}`
        return {
            role: 'system',
            id: messageId,
            createdAt: new Date(block.createdAt),
            content: [{ type: 'text', text: renderEventLabel(block.event) }],
            metadata: {
                custom: {
                    kind: 'event',
                    event: block.event,
                    invokedAt: block.invokedAt,
                    model: block.model
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'cli-output') {
        const messageId = `cli:${block.id}`
        return {
            role: block.source === 'user' ? 'user' : 'assistant',
            id: messageId,
            createdAt: new Date(block.createdAt),
            content: [{ type: 'text', text: block.text }],
            metadata: {
                custom: {
                    kind: 'cli-output',
                    source: block.source,
                    invokedAt: block.invokedAt,
                    durationMs: block.durationMs,
                    usage: block.usage,
                    model: block.model
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'tool-group') {
        const groupBlock: ToolGroupBlock = block
        return {
            role: 'assistant',
            id: `tool:${groupBlock.id}`,
            createdAt: new Date(groupBlock.createdAt),
            content: [{
                type: 'tool-call',
                toolCallId: groupBlock.id,
                toolName: 'ToolGroup',
                argsText: '',
                artifact: groupBlock
            }],
            metadata: {
                custom: {
                    kind: 'tool',
                    toolCallId: groupBlock.id,
                    invokedAt: groupBlock.invokedAt ?? null
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    const toolBlock: ToolCallBlock = block
    const messageId = `tool:${toolBlock.id}`
    const inputText = safeStringify(toolBlock.tool.input)

    return {
        role: 'assistant',
        id: messageId,
        createdAt: new Date(toolBlock.createdAt),
        content: [{
            type: 'tool-call',
            toolCallId: toolBlock.id,
            toolName: toolBlock.tool.name,
            argsText: inputText,
            result: toolBlock.tool.result,
            isError: toolBlock.tool.state === 'error',
            artifact: toolBlock
        }],
        metadata: {
            custom: {
                kind: 'tool',
                toolCallId: toolBlock.id,
                invokedAt: toolBlock.invokedAt,
                durationMs: toolBlock.durationMs,
                usage: toolBlock.usage,
                model: toolBlock.model
            } satisfies HappyChatMessageMetadata
        }
    }
}

type TextMessagePart = { type: 'text'; text: string }

function getTextFromParts(parts: readonly { type: string }[] | undefined): string {
    if (!parts) return ''

    return parts
        .filter((part): part is TextMessagePart => part.type === 'text' && typeof (part as TextMessagePart).text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim()
}

type ExtractedAttachmentMetadata = { __attachmentMetadata: AttachmentMetadata }

function isAttachmentMetadataJson(text: string): ExtractedAttachmentMetadata | null {
    try {
        const parsed = JSON.parse(text) as unknown
        if (parsed && typeof parsed === 'object' && '__attachmentMetadata' in parsed) {
            return parsed as ExtractedAttachmentMetadata
        }
        return null
    } catch {
        return null
    }
}

function extractMessageContent(message: AppendMessage): { text: string; attachments: AttachmentMetadata[] } {
    if (message.role !== 'user') return { text: '', attachments: [] }

    // Extract attachments from attachment content
    const attachments: AttachmentMetadata[] = []
    const otherAttachmentTexts: string[] = []

    const attachmentParts = message.attachments?.flatMap((attachment) => attachment.content ?? []) ?? []
    for (const part of attachmentParts) {
        if (part.type === 'text' && typeof (part as TextMessagePart).text === 'string') {
            const textPart = part as TextMessagePart
            const extracted = isAttachmentMetadataJson(textPart.text)
            if (extracted) {
                attachments.push(extracted.__attachmentMetadata)
            } else {
                otherAttachmentTexts.push(textPart.text)
            }
        }
    }

    const contentText = getTextFromParts(message.content)
    const text = [otherAttachmentTexts.join('\n'), contentText]
        .filter((value) => value.length > 0)
        .join('\n\n')
        .trim()

    return { text, attachments }
}

export function useHappyRuntime(props: {
    session: Session
    blocks: readonly VisibleChatBlock[]
    isSending: boolean
    isRunning?: boolean
    onSendMessage: (text: string, attachments?: AttachmentMetadata[]) => void
    onAbort: () => Promise<void>
    attachmentAdapter?: AttachmentAdapter
    allowSendWhenInactive?: boolean
}) {
    const isRunning = props.isRunning ?? props.session.thinking

    // Compute response-group aggregates once per block list so we can
    // inject the summed metadata onto each group's first visible block.
    // The library's `joinExternalMessages` only preserves
    // `metadata.custom` from the first block of a joined chunk, so this
    // is the surface that survives the join.
    const aggregates = useMemo(
        () => aggregateResponseGroups(props.blocks),
        [props.blocks]
    )

    const convertBlock = useCallback(
        (block: VisibleChatBlock): ThreadMessageLike => {
            const message = toThreadMessageLike(block)
            const aggregate = aggregates.get(block.id)
            if (!aggregate) return message
            const existing = message.metadata?.custom as HappyChatMessageMetadata | undefined
            return {
                ...message,
                metadata: {
                    ...message.metadata,
                    custom: {
                        ...(existing ?? { kind: 'assistant' }),
                        usage: aggregate.usage,
                        model: aggregate.model,
                        invokedAt: aggregate.invokedAt,
                        durationMs: aggregate.durationMs,
                        turnCount: aggregate.turnCount
                    } satisfies HappyChatMessageMetadata
                }
            }
        },
        [aggregates]
    )

    // Use cached message converter for performance optimization
    // This prevents re-converting all messages on every render
    const convertedMessages = useExternalMessageConverter<VisibleChatBlock>({
        callback: convertBlock,
        messages: props.blocks as VisibleChatBlock[],
        isRunning,
    })

    const onNew = useCallback(async (message: AppendMessage) => {
        const { text, attachments } = extractMessageContent(message)
        if (!text && attachments.length === 0) return
        props.onSendMessage(text, attachments.length > 0 ? attachments : undefined)
    }, [props.onSendMessage])

    const onCancel = useCallback(async () => {
        await props.onAbort()
    }, [props.onAbort])

    // Memoize the adapter to avoid recreating on every render
    // useExternalStoreRuntime may use adapter identity for subscriptions
    const adapter = useMemo(() => ({
        isDisabled: props.isSending || (!props.session.active && !props.allowSendWhenInactive),
        isRunning,
        messages: convertedMessages,
        onNew,
        onCancel,
        adapters: props.attachmentAdapter ? { attachments: props.attachmentAdapter } : undefined,
        unstable_capabilities: { copy: true }
    }), [
        props.session.active,
        props.isSending,
        props.allowSendWhenInactive,
        isRunning,
        convertedMessages,
        onNew,
        onCancel,
        props.attachmentAdapter
    ])

    return useExternalStoreRuntime(adapter)
}
