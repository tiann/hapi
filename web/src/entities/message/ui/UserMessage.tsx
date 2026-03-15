import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { LazyRainbowText } from '@/components/LazyRainbowText'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { getHappyChatMetadata, getMessageTextContent } from '@/lib/assistant-runtime'
import { MessageStatusIndicator } from './MessageStatusIndicator'
import { MessageAttachments } from './MessageAttachments'
import { CliOutputBlock } from '@/components/CliOutputBlock'

export function HappyUserMessage() {
    const ctx = useHappyChatContext()
    const role = useAssistantState(({ message }) => message.role)
    const text = useAssistantState(({ message }) => message.role === 'user' ? getMessageTextContent(message) : '')
    const status = useAssistantState(({ message }) => {
        if (message.role !== 'user') return undefined
        return getHappyChatMetadata(message)?.status
    })
    const localId = useAssistantState(({ message }) => {
        if (message.role !== 'user') return null
        return getHappyChatMetadata(message)?.localId ?? null
    })
    const attachments = useAssistantState(({ message }) => {
        if (message.role !== 'user') return undefined
        return getHappyChatMetadata(message)?.attachments
    })
    const isCliOutput = useAssistantState(({ message }) => getHappyChatMetadata(message)?.kind === 'cli-output')
    const cliText = useAssistantState(({ message }) => {
        if (getHappyChatMetadata(message)?.kind !== 'cli-output') return ''
        return getMessageTextContent(message)
    })

    if (role !== 'user') return null
    const canRetry = status === 'failed' && typeof localId === 'string' && Boolean(ctx.onRetryMessage)
    const onRetry = canRetry ? () => ctx.onRetryMessage!(localId) : undefined

    const userBubbleClass = 'w-fit min-w-0 max-w-[92%] ml-auto rounded-xl bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)] shadow-sm'

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root className="px-1 min-w-0 max-w-full overflow-x-hidden">
                <div className="ml-auto w-full max-w-[92%]">
                    <CliOutputBlock text={cliText} />
                </div>
            </MessagePrimitive.Root>
        )
    }

    const hasText = text.length > 0
    const hasAttachments = attachments && attachments.length > 0

    return (
        <MessagePrimitive.Root className={userBubbleClass}>
            <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                    {hasText && <LazyRainbowText text={text} />}
                    {hasAttachments && <MessageAttachments attachments={attachments} />}
                </div>
                {status ? (
                    <div className="shrink-0 self-end pb-0.5">
                        <MessageStatusIndicator status={status} onRetry={onRetry} />
                    </div>
                ) : null}
            </div>
        </MessagePrimitive.Root>
    )
}
