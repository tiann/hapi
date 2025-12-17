import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import type { MessageStatus } from '@/types/api'
import { LazyRainbowText } from '@/components/LazyRainbowText'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'

function ErrorIcon() {
    return (
        <svg className="h-[14px] w-[14px]" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11" r="0.75" fill="currentColor" />
        </svg>
    )
}

function MessageStatusIndicator(props: {
    status?: MessageStatus
    onRetry?: () => void
}) {
    if (props.status !== 'failed') {
        return null
    }

    return (
        <span className="inline-flex items-center gap-1">
            <span className="text-red-500">
                <ErrorIcon />
            </span>
            {props.onRetry ? (
                <button
                    type="button"
                    onClick={props.onRetry}
                    className="text-xs text-blue-500 hover:underline"
                >
                    重试
                </button>
            ) : null}
        </span>
    )
}

export function HappyUserMessage() {
    const ctx = useHappyChatContext()
    const message = useAssistantState(({ message }) => message)

    if (message.role !== 'user') return null

    const text = message.content.find((part) => part.type === 'text')?.text ?? ''
    const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
    const status = custom?.status
    const localId = custom?.localId
    const canRetry = status === 'failed' && typeof localId === 'string' && Boolean(ctx.onRetryMessage)
    const onRetry = canRetry ? () => ctx.onRetryMessage!(localId) : undefined

    const userBubbleClass = 'w-fit max-w-[92%] ml-auto rounded-xl bg-[var(--app-secondary-bg)] px-3 py-2 text-[var(--app-fg)] shadow-sm'

    return (
        <MessagePrimitive.Root className={userBubbleClass}>
            <div className="flex items-end gap-2">
                <div className="flex-1">
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

