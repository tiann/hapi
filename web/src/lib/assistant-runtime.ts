import { useCallback, useMemo } from 'react'
import type { AppendMessage, AttachmentAdapter, ThreadMessageLike } from '@assistant-ui/react'
import { useExternalMessageConverter, useExternalStoreRuntime } from '@assistant-ui/react'
import { safeStringify } from '@hapi/protocol'
import { renderEventLabel } from '@/chat/presentation'
import { groupConsecutiveToolBlocks, isToolGroupBlock, type ToolDisplayBlock } from '@/chat/toolGrouping'
import type { ChatBlock, CliOutputBlock } from '@/chat/types'
import type { AgentEvent, ToolCallBlock } from '@/chat/types'
import type { AttachmentMetadata, MessageStatus as HappyMessageStatus, Session } from '@/types/api'

export const AGENT_ATTACHMENTS_DATA_PART_NAME = 'hapi-agent-attachments'
export const MOA_REFERENCE_DATA_PART_NAME = 'hapi-moa-reference'

export type HappyChatMessageMetadata = {
    kind: 'user' | 'assistant' | 'tool' | 'tool-group' | 'event' | 'cli-output' | 'moa-reference'
    status?: HappyMessageStatus
    localId?: string | null
    originalText?: string
    toolCallId?: string
    event?: AgentEvent
    source?: CliOutputBlock['source']
    attachments?: AttachmentMetadata[]
    timestampSource?: 'completion'
    timestampAt?: number | null
}

function getCompletionTimestampMetadata(block: { displayTimestamp?: number | null }): Pick<HappyChatMessageMetadata, 'timestampSource' | 'timestampAt'> {
    return {
        timestampSource: 'completion',
        timestampAt: typeof block.displayTimestamp === 'number' ? block.displayTimestamp : null
    }
}

export function toThreadMessageLike(block: ToolDisplayBlock): ThreadMessageLike {
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
                    attachments: block.attachments
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
                    ...getCompletionTimestampMetadata(block)
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
                    ...getCompletionTimestampMetadata(block)
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'moa-reference') {
        const messageId = `assistant:${block.id}`
        return {
            role: 'assistant',
            id: messageId,
            createdAt: new Date(block.createdAt),
            content: [{
                type: 'data' as const,
                name: MOA_REFERENCE_DATA_PART_NAME,
                data: {
                    label: block.label,
                    text: block.text,
                    ...(block.index !== undefined ? { index: block.index } : {}),
                    ...(block.count !== undefined ? { count: block.count } : {})
                }
            }],
            metadata: {
                custom: {
                    kind: 'moa-reference',
                    ...getCompletionTimestampMetadata(block)
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (block.kind === 'agent-attachments') {
        const messageId = `assistant:${block.id}`
        return {
            role: 'assistant',
            id: messageId,
            createdAt: new Date(block.createdAt),
            content: [{
                type: 'data' as const,
                name: AGENT_ATTACHMENTS_DATA_PART_NAME,
                data: {
                    attachments: block.attachments
                }
            }],
            metadata: {
                custom: {
                    kind: 'assistant',
                    localId: block.localId,
                    attachments: block.attachments,
                    ...getCompletionTimestampMetadata(block)
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
                custom: { kind: 'event', event: block.event } satisfies HappyChatMessageMetadata
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
                    ...(block.source === 'assistant' ? getCompletionTimestampMetadata(block) : {})
                } satisfies HappyChatMessageMetadata
            }
        }
    }

    if (isToolGroupBlock(block)) {
        const messageId = block.id

        return {
            role: 'assistant',
            id: messageId,
            createdAt: new Date(block.createdAt),
            content: [{
                type: 'tool-call',
                toolCallId: block.id,
                toolName: 'tool-group',
                argsText: '',
                result: undefined,
                isError: false,
                artifact: block
            }],
            metadata: {
                custom: {
                    kind: 'tool-group',
                    toolCallId: block.id,
                    ...getCompletionTimestampMetadata(block)
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
                ...getCompletionTimestampMetadata(toolBlock)
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
    blocks: readonly ChatBlock[]
    isSending: boolean
    onSendMessage: (text: string, attachments?: AttachmentMetadata[]) => void | Promise<void>
    onAbort: () => Promise<void>
    attachmentAdapter?: AttachmentAdapter
    allowSendWhenInactive?: boolean
}) {
    const displayBlocks = useMemo(
        () => groupConsecutiveToolBlocks(props.blocks),
        [props.blocks]
    )

    // Use cached message converter for performance optimization
    // This prevents re-converting all messages on every render
    const convertedMessages = useExternalMessageConverter<ToolDisplayBlock>({
        callback: toThreadMessageLike,
        messages: displayBlocks,
        isRunning: props.session.thinking,
    })

    const onNew = useCallback(async (message: AppendMessage) => {
        const { text, attachments } = extractMessageContent(message)
        if (!text && attachments.length === 0) return
        await props.onSendMessage(text, attachments.length > 0 ? attachments : undefined)
    }, [props.onSendMessage])

    const onCancel = useCallback(async () => {
        await props.onAbort()
    }, [props.onAbort])

    // Memoize the adapter to avoid recreating on every render
    // useExternalStoreRuntime may use adapter identity for subscriptions
    const adapter = useMemo(() => ({
        isDisabled: props.isSending || (!props.session.active && !props.allowSendWhenInactive),
        isRunning: props.session.thinking,
        messages: convertedMessages,
        onNew,
        onCancel,
        adapters: props.attachmentAdapter ? { attachments: props.attachmentAdapter } : undefined,
        unstable_capabilities: { copy: true }
    }), [
        props.session.active,
        props.isSending,
        props.allowSendWhenInactive,
        props.session.thinking,
        convertedMessages,
        onNew,
        onCancel,
        props.attachmentAdapter
    ])

    return useExternalStoreRuntime(adapter)
}
