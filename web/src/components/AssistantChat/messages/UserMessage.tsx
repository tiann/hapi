import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { LazyRainbowText } from '@/components/LazyRainbowText'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { CliOutputBlock } from '@/components/CliOutputBlock'

export function HappyUserMessage() {
    const ctx = useHappyChatContext()
    const role = useAssistantState(({ message }) => message.role)
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
    const isCliOutput = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const cliText = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
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

    return (
        <MessagePrimitive.Root className={userBubbleClass}>
            <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                    <LazyRainbowText text={text} />
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
