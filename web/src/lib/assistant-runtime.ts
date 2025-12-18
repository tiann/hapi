import { useMemo } from 'react'
import type { AppendMessage, ExternalStoreAdapter, ThreadMessageLike } from '@assistant-ui/react'
import { useExternalStoreRuntime } from '@assistant-ui/react'
import { renderEventLabel } from '@/chat/presentation'
import type { ChatBlock } from '@/chat/types'
import type { AgentEvent, ToolCallBlock } from '@/chat/types'
import type { MessageStatus as HappyMessageStatus, Session } from '@/types/api'

function safeStringify(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        const stringified = JSON.stringify(value, null, 2)
        return typeof stringified === 'string' ? stringified : String(value)
    } catch {
        return String(value)
    }
}

export type HappyChatMessageMetadata = {
    kind: 'user' | 'assistant' | 'tool' | 'event'
    status?: HappyMessageStatus
    localId?: string | null
    originalText?: string
    toolCallId?: string
    event?: AgentEvent
}

function toThreadMessageLike(block: ChatBlock): ThreadMessageLike {
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
                    originalText: block.originalText
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
                custom: { kind: 'assistant' } satisfies HappyChatMessageMetadata
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
            custom: { kind: 'tool', toolCallId: toolBlock.id } satisfies HappyChatMessageMetadata
        }
    }
}

function getTextFromAppendMessage(message: AppendMessage): string | null {
    if (message.role !== 'user') return null

    const parts = message.content
    const text = parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim()

    return text.length > 0 ? text : null
}

export function useHappyRuntime(props: {
    session: Session
    blocks: readonly ChatBlock[]
    isSending: boolean
    onSendMessage: (text: string) => void
    onAbort: () => Promise<void>
}) {
    const adapter = useMemo(() => {
        return {
            isDisabled: !props.session.active || props.isSending,
            isRunning: props.session.thinking,
            messages: props.blocks,
            onNew: async (message: AppendMessage) => {
                const text = getTextFromAppendMessage(message)
                if (!text) return
                props.onSendMessage(text)
            },
            onCancel: async () => {
                await props.onAbort()
            },
            convertMessage: (block: ChatBlock) => toThreadMessageLike(block),
            unstable_capabilities: { copy: true }
        } satisfies ExternalStoreAdapter<ChatBlock>
    }, [props.session.active, props.session.thinking, props.isSending, props.blocks, props.onSendMessage, props.onAbort])

    return useExternalStoreRuntime(adapter)
}
