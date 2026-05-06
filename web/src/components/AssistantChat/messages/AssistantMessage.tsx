import { useCallback, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { MarkdownText } from '@/components/assistant-ui/markdown-text'
import { Reasoning, ReasoningGroup } from '@/components/assistant-ui/reasoning'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { CopyIcon, CheckIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { getAssistantCopyText } from '@/components/AssistantChat/messages/assistantCopyText'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { MessageMetadata } from '@/components/AssistantChat/messages/MessageMetadata'
import { isNestedInteractiveEvent } from '@/components/AssistantChat/messages/metadataToggle'

const TOOL_COMPONENTS = {
    Fallback: HappyToolMessage
} as const

const MESSAGE_PART_COMPONENTS = {
    Text: MarkdownText,
    Reasoning: Reasoning,
    ReasoningGroup: ReasoningGroup,
    tools: TOOL_COMPONENTS
} as const

export function HappyAssistantMessage() {
    const { copied, copy } = useCopyToClipboard()
    const [showMetadata, setShowMetadata] = useState(false)
    const toggleMetadata = useCallback((event: MouseEvent<HTMLElement>) => {
        if (isNestedInteractiveEvent(event)) return
        setShowMetadata((open) => !open)
    }, [])
    const messageId = useAssistantState(({ message }) => message.id)
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
        return getAssistantCopyText(message.content)
    })

    const invokedAt = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.invokedAt)
    const durationMs = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.durationMs)
    const usage = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.usage)
    const messageModel = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.model)

    const hasMetadata = invokedAt != null
        || (typeof durationMs === 'number' && durationMs >= 0)
        || usage != null
        || (messageModel != null && messageModel !== '')

    const onMetadataKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        if (isNestedInteractiveEvent(event)) return
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setShowMetadata((open) => !open)
        }
    }, [])

    const rootClass = toolOnly
        ? 'py-1 min-w-0 max-w-full overflow-x-hidden'
        : 'px-1 min-w-0 max-w-full overflow-x-hidden'

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root
                id={getConversationMessageAnchorId(messageId)}
                className="scroll-mt-4 px-1 min-w-0 max-w-full overflow-x-hidden"
            >
                <CliOutputBlock text={cliText} />
                {hasMetadata && (
                    <button
                        type="button"
                        onClick={() => setShowMetadata((open) => !open)}
                        aria-expanded={showMetadata}
                        className="mt-1 text-[10px] text-[var(--app-hint)] underline-offset-2 hover:text-[var(--app-fg)] hover:underline"
                    >
                        {showMetadata ? 'Hide metadata' : 'Show metadata'}
                    </button>
                )}
                {showMetadata && (
                    <MessageMetadata
                        invokedAt={invokedAt}
                        durationMs={durationMs}
                        usage={usage}
                        model={messageModel ?? null}
                        className="mt-1"
                    />
                )}
            </MessagePrimitive.Root>
        )
    }

    return (
        <MessagePrimitive.Root
            id={getConversationMessageAnchorId(messageId)}
            className={`${rootClass} ${copyText ? 'group/msg' : ''} scroll-mt-4`}
        >
            <div className="flex items-start gap-2">
                <div
                    className={hasMetadata ? 'min-w-0 flex-1 cursor-pointer' : 'min-w-0 flex-1'}
                    onClick={hasMetadata ? toggleMetadata : undefined}
                    onKeyDown={hasMetadata ? onMetadataKeyDown : undefined}
                    role={hasMetadata ? 'button' : undefined}
                    tabIndex={hasMetadata ? 0 : undefined}
                    aria-expanded={hasMetadata ? showMetadata : undefined}
                >
                    <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
                    {showMetadata && (
                        <MessageMetadata
                            invokedAt={invokedAt}
                            durationMs={durationMs}
                            usage={usage}
                            model={messageModel ?? null}
                            className="mt-1"
                        />
                    )}
                </div>
                {copyText ? (
                    <div className="happy-message-actions-first-line hidden sm:flex shrink-0 opacity-0 group-hover/msg:opacity-100 transition-opacity">
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
                ) : null}
            </div>
        </MessagePrimitive.Root>
    )
}
