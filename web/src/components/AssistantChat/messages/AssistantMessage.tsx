import { useState } from 'react'
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
import { CodexReviewCard } from '@/components/AssistantChat/messages/CodexReviewCard'
import { MessageTimestamp } from '@/components/AssistantChat/messages/MessageTimestamp'

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
    const messageId = useAssistantState(({ message }) => message.id)
    const isCliOutput = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const codexReview = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'codex-review' ? custom.review : undefined
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
    const turnCount = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.turnCount)

    const hasMetadata = invokedAt != null
        || (typeof durationMs === 'number' && durationMs >= 0)
        || usage != null
        || (messageModel != null && messageModel !== '')
        || (typeof turnCount === 'number' && turnCount >= 2)

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
                <div className="mt-1 flex items-center gap-2">
                    <MessageTimestamp className="text-[10px] leading-none text-[var(--app-hint)]" />
                    {hasMetadata && (
                        <button
                            type="button"
                            onClick={() => setShowMetadata((open) => !open)}
                            aria-expanded={showMetadata}
                            className="text-[10px] text-[var(--app-hint)] underline-offset-2 hover:text-[var(--app-fg)] hover:underline"
                        >
                            {showMetadata ? 'Hide info' : 'Show info'}
                        </button>
                    )}
                </div>
                {showMetadata && (
                    <MessageMetadata
                        invokedAt={invokedAt}
                        durationMs={durationMs}
                        usage={usage}
                        model={messageModel ?? null}
                        turnCount={turnCount}
                    />
                )}
            </MessagePrimitive.Root>
        )
    }

    if (codexReview) {
        return (
            <MessagePrimitive.Root
                id={getConversationMessageAnchorId(messageId)}
                className={`${rootClass} ${copyText ? 'group/msg' : ''} scroll-mt-4`}
            >
                <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                        <CodexReviewCard review={codexReview} />
                        <div className="mt-1 flex items-center gap-2">
                            <MessageTimestamp className="text-[10px] leading-none text-[var(--app-hint)]" />
                            {hasMetadata && (
                                <button
                                    type="button"
                                    onClick={() => setShowMetadata((open) => !open)}
                                    aria-expanded={showMetadata}
                                    className="text-[10px] text-[var(--app-hint)] underline-offset-2 hover:text-[var(--app-fg)] hover:underline"
                                >
                                    {showMetadata ? 'Hide info' : 'Show info'}
                                </button>
                            )}
                        </div>
                        {showMetadata && (
                            <MessageMetadata
                                invokedAt={invokedAt}
                                durationMs={durationMs}
                                usage={usage}
                                model={messageModel ?? null}
                                turnCount={turnCount}
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

    if (toolOnly) {
        return (
            <MessagePrimitive.Root
                id={getConversationMessageAnchorId(messageId)}
                className={`${rootClass} ${copyText ? 'group/msg' : ''} scroll-mt-4`}
            >
                <div className="min-w-0">
                    <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
                    <div className="mt-1 flex items-center gap-2">
                        <MessageTimestamp className="text-[10px] leading-none text-[var(--app-hint)]" />
                        {hasMetadata && (
                            <button
                                type="button"
                                onClick={() => setShowMetadata((open) => !open)}
                                aria-expanded={showMetadata}
                                className="text-[10px] text-[var(--app-hint)] underline-offset-2 hover:text-[var(--app-fg)] hover:underline"
                            >
                                {showMetadata ? 'Hide info' : 'Show info'}
                            </button>
                        )}
                    </div>
                    {showMetadata && (
                        <MessageMetadata
                            invokedAt={invokedAt}
                            durationMs={durationMs}
                            usage={usage}
                            model={messageModel ?? null}
                            turnCount={turnCount}
                        />
                    )}
                </div>
            </MessagePrimitive.Root>
        )
    }

    return (
        <MessagePrimitive.Root
            id={getConversationMessageAnchorId(messageId)}
            className={`${rootClass} ${copyText ? 'group/msg' : ''} scroll-mt-4`}
        >
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
                    <div className="mt-1 flex items-center gap-2">
                        <MessageTimestamp className="text-[10px] leading-none text-[var(--app-hint)]" />
                        {hasMetadata && (
                            <button
                                type="button"
                                onClick={() => setShowMetadata((open) => !open)}
                                aria-expanded={showMetadata}
                                className="text-[10px] text-[var(--app-hint)] underline-offset-2 hover:text-[var(--app-fg)] hover:underline"
                            >
                                {showMetadata ? 'Hide info' : 'Show info'}
                            </button>
                        )}
                    </div>
                    {showMetadata && (
                        <MessageMetadata
                            invokedAt={invokedAt}
                            durationMs={durationMs}
                            usage={usage}
                            model={messageModel ?? null}
                            turnCount={turnCount}
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
