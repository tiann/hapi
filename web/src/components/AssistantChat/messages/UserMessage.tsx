import { useCallback, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { MessageAttachments } from '@/components/AssistantChat/messages/MessageAttachments'
import { UserBubbleContent, getUserBubbleClassName, shouldShowMessageStatus } from '@/components/AssistantChat/messages/user-bubble'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { CopyIcon, CheckIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { MessageMetadata } from '@/components/AssistantChat/messages/MessageMetadata'
import { isNestedInteractiveEvent } from '@/components/AssistantChat/messages/metadataToggle'

export function HappyUserMessage() {
    const ctx = useHappyChatContext()
    const { copied, copy } = useCopyToClipboard()
    const [showMetadata, setShowMetadata] = useState(false)
    const toggleMetadata = useCallback((event: MouseEvent<HTMLElement>) => {
        if (isNestedInteractiveEvent(event)) return
        setShowMetadata((open) => !open)
    }, [])
    const role = useAssistantState(({ message }) => message.role)
    const messageId = useAssistantState(({ message }) => message.id)
    const text = useAssistantState(({ message }) => {
        if (message.role !== 'user') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    const status = useAssistantState(({ message }) => {
        if (message.role !== 'user') return undefined
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.status
    })
    const localId = useAssistantState(({ message }) => {
        if (message.role !== 'user') return null
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.localId ?? null
    })
    const attachments = useAssistantState(({ message }) => {
        if (message.role !== 'user') return undefined
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.attachments
    })
    const isCliOutput = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const cliText = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    const invokedAt = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.invokedAt)

    const hasMetadata = invokedAt != null

    const onMetadataKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
        if (isNestedInteractiveEvent(event)) return
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setShowMetadata((open) => !open)
        }
    }, [])

    if (role !== 'user') return null
    const canRetry = status === 'failed' && typeof localId === 'string' && Boolean(ctx.onRetryMessage)
    const onRetry = canRetry ? () => ctx.onRetryMessage!(localId) : undefined
    const showStatus = shouldShowMessageStatus(status)

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root
                id={getConversationMessageAnchorId(messageId)}
                className="scroll-mt-4 px-1 min-w-0 max-w-full overflow-x-hidden"
            >
                <div className="ml-auto w-full max-w-[92%]">
                    <CliOutputBlock text={cliText} />
                    {hasMetadata && (
                        <div className="mt-1 flex justify-end">
                            <button
                                type="button"
                                onClick={() => setShowMetadata((open) => !open)}
                                aria-expanded={showMetadata}
                                className="text-[10px] text-[var(--app-hint)] underline-offset-2 hover:text-[var(--app-fg)] hover:underline"
                            >
                                {showMetadata ? 'Hide metadata' : 'Show metadata'}
                            </button>
                        </div>
                    )}
                    {showMetadata && invokedAt != null && (
                        <MessageMetadata invokedAt={invokedAt} className="mt-1 justify-end" />
                    )}
                </div>
            </MessagePrimitive.Root>
        )
    }

    const hasText = text.length > 0
    const hasAttachments = attachments && attachments.length > 0

    return (
        <MessagePrimitive.Root
            id={getConversationMessageAnchorId(messageId)}
            className={`${getUserBubbleClassName(status)} group/msg scroll-mt-4 ${hasMetadata ? 'cursor-pointer' : ''}`}
            onClick={hasMetadata ? toggleMetadata : undefined}
            onKeyDown={hasMetadata ? onMetadataKeyDown : undefined}
            role={hasMetadata ? 'button' : undefined}
            tabIndex={hasMetadata ? 0 : undefined}
            aria-expanded={hasMetadata ? showMetadata : undefined}
        >
            <div className="flex flex-col gap-1">
                <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                        {hasText ? <UserBubbleContent text={text} /> : null}
                        {hasAttachments ? <MessageAttachments attachments={attachments} /> : null}
                    </div>
                    {(hasText || showStatus) && (
                        <div className="happy-message-actions-first-line flex shrink-0 items-center gap-1">
                            {hasText && (
                                <button
                                    type="button"
                                    title="Copy"
                                    className="rounded-md p-0.5 opacity-60 transition-[opacity,background-color] hover:bg-[var(--app-chat-user-chip-bg)] sm:opacity-0 sm:group-hover/msg:opacity-100"
                                    onClick={(event) => {
                                        event.stopPropagation()
                                        copy(text)
                                    }}
                                >
                                    {copied
                                        ? <CheckIcon className="h-3.5 w-3.5 text-green-500" />
                                        : <CopyIcon className="h-3.5 w-3.5 text-[var(--app-hint)]" />}
                                </button>
                            )}
                            {showStatus ? <MessageStatusIndicator status={status} onRetry={onRetry} /> : null}
                        </div>
                    )}
                </div>
                {showMetadata && invokedAt != null && (
                    <MessageMetadata invokedAt={invokedAt} className="justify-end opacity-60" />
                )}
            </div>
        </MessagePrimitive.Root>
    )
}
