import { useAssistantState } from '@assistant-ui/react'
import { getEventPresentation } from '@/chat/presentation'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'

export function HappySystemMessage() {
    const message = useAssistantState(({ message }) => message)
    if (message.role !== 'system') return null

    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
    const event = custom?.kind === 'event' ? custom.event : undefined
    const icon = event ? getEventPresentation(event).icon : null

    return (
        <div className="py-1">
            <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                <span className="inline-flex items-center gap-1">
                    {icon ? <span aria-hidden="true">{icon}</span> : null}
                    <span>{text}</span>
                </span>
            </div>
        </div>
    )
}
