import { useMemo } from 'react'
import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { MarkdownText } from '@/components/assistant-ui/markdown-text'
import { Reasoning, ReasoningGroup } from '@/components/assistant-ui/reasoning'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { CopyIcon, CheckIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { AGENT_ATTACHMENTS_DATA_PART_NAME, type HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { MOA_REFERENCE_DATA_PART_NAME } from '@/lib/assistant-runtime'
import { getAssistantCopyText } from '@/components/AssistantChat/messages/assistantCopyText'
import { MessageAttachments } from '@/components/AssistantChat/messages/MessageAttachments'
import { HappyMessageTimestamp } from '@/components/AssistantChat/messages/MessageTimestamp'
import { MoaReferenceMessage, type MoaReferenceData } from '@/components/AssistantChat/messages/MoaReferenceMessage'
import type { AttachmentMetadata } from '@/types/api'

const EMPTY_MESSAGE_CONTENT: readonly { type: string }[] = []

const TOOL_COMPONENTS = {
    Fallback: HappyToolMessage
} as const

const MESSAGE_PART_COMPONENTS = {
    Text: MarkdownText,
    Reasoning: Reasoning,
    ReasoningGroup: ReasoningGroup,
    tools: TOOL_COMPONENTS
} as const

function getAttachmentsFromContent(parts: readonly { type: string }[] | undefined): AttachmentMetadata[] {
    if (!parts) return []
    return parts.flatMap((part) => {
        if (part.type !== 'data') return []
        const dataPart = part as { name?: string; data?: { attachments?: AttachmentMetadata[] } }
        if (dataPart.name !== AGENT_ATTACHMENTS_DATA_PART_NAME) return []
        const attachments = dataPart.data?.attachments
        return Array.isArray(attachments) ? attachments : []
    })
}

function getMoaReferencesFromContent(parts: readonly { type: string }[] | undefined): MoaReferenceData[] {
    if (!parts) return []
    const references: MoaReferenceData[] = []
    for (const part of parts) {
        if (part.type !== 'data') continue
        const dataPart = part as { name?: string; data?: Partial<MoaReferenceData> }
        if (dataPart.name !== MOA_REFERENCE_DATA_PART_NAME) continue
        const data = dataPart.data
        if (!data || typeof data.label !== 'string' || typeof data.text !== 'string') continue
        references.push({
            label: data.label,
            text: data.text,
            ...(typeof data.index === 'number' ? { index: data.index } : {}),
            ...(typeof data.count === 'number' ? { count: data.count } : {})
        })
    }
    return references
}

export function HappyAssistantMessage() {
    const { copied, copy } = useCopyToClipboard()
    const isCliOutput = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const cliText = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    const toolOnly = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return false
        const parts = message.content
        return parts.length > 0 && parts.every((part) => part.type === 'tool-call')
    })
    const copyText = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return ''
        const text = getAssistantCopyText(message.content)
        const references = getMoaReferencesFromContent(message.content)
        if (references.length === 0) return text
        return [text, ...references.map((reference) => reference.text.trim())].filter(Boolean).join('\n\n')
    })
    const messageContent = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return EMPTY_MESSAGE_CONTENT
        return message.content
    })
    const contentAttachments = useMemo(() => getAttachmentsFromContent(messageContent), [messageContent])
    const moaReferences = useMemo(() => getMoaReferencesFromContent(messageContent), [messageContent])
    const metadataAttachments = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return undefined
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.attachments
    })
    const hasRenderableContent = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return true
        return message.content.some((part) => {
            if (part.type === 'text') return typeof part.text === 'string' && part.text.trim().length > 0
            if (part.type === 'data') return false
            return true
        })
    })
    const attachmentList = contentAttachments.length > 0 ? contentAttachments : metadataAttachments ?? []
    const hasAttachments = attachmentList.length > 0
    const rootClass = toolOnly
        ? 'py-1 min-w-0 max-w-full overflow-x-hidden'
        : 'px-1 min-w-0 max-w-full overflow-x-hidden'

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root className="px-1 min-w-0 max-w-full overflow-x-hidden">
                <CliOutputBlock text={cliText} />
                <HappyMessageTimestamp align="left" className="mt-1" />
            </MessagePrimitive.Root>
        )
    }

    return (
        <MessagePrimitive.Root className={`${rootClass} ${copyText ? 'group/msg' : ''}`}>
            {hasRenderableContent && (
                <div className="min-w-0">
                    <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
                </div>
            )}
            {moaReferences.map((reference) => (
                <MoaReferenceMessage
                    key={`${reference.index ?? 'x'}:${reference.count ?? 'x'}:${reference.label}`}
                    reference={reference}
                />
            ))}
            {hasAttachments && <MessageAttachments attachments={attachmentList} />}
            <div className="mt-1 flex items-center justify-between gap-2">
                <HappyMessageTimestamp align="left" />
                {copyText && (
                    <div className="flex opacity-60 sm:opacity-0 sm:group-hover/msg:opacity-100 transition-opacity">
                        <button
                            type="button"
                            title="Copy"
                            className="p-0.5 rounded hover:bg-[var(--app-subtle-bg)] transition-colors"
                            onClick={() => copy(copyText)}
                        >
                            {copied
                                ? <CheckIcon className="h-3.5 w-3.5 text-green-500" />
                                : <CopyIcon className="h-3.5 w-3.5 text-[var(--app-hint)]" />}
                        </button>
                    </div>
                )}
            </div>
        </MessagePrimitive.Root>
    )
}
