import type { ReactNode } from 'react'
import { ThreadPrimitive } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'

const THREAD_MESSAGE_COMPONENTS = {
    UserMessage: HappyUserMessage,
    AssistantMessage: HappyAssistantMessage,
    SystemMessage: HappySystemMessage
} as const

export function HappyThread(props: {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    header?: ReactNode
}) {
    return (
        <HappyChatProvider value={{
            api: props.api,
            sessionId: props.sessionId,
            metadata: props.metadata,
            disabled: props.disabled,
            onRefresh: props.onRefresh,
            onRetryMessage: props.onRetryMessage
        }}>
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
                <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto" autoScroll>
                    <div className="mx-auto w-full max-w-[720px] p-3">
                        {props.header}
                        <div className="flex flex-col gap-3">
                            <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
                        </div>
                    </div>
                </ThreadPrimitive.Viewport>
            </ThreadPrimitive.Root>
        </HappyChatProvider>
    )
}
