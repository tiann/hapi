import { useAssistantState } from '@assistant-ui/react'
import { getEventPresentation } from '@/chat/presentation'
import { getHappyChatMetadata, getMessageTextContent } from '@/lib/assistant-runtime'

export function HappySystemMessage() {
    const role = useAssistantState(({ message }) => message.role)
    const text = useAssistantState(({ message }) => message.role === 'system' ? getMessageTextContent(message) : '')
    const icon = useAssistantState(({ message }) => {
        if (message.role !== 'system') return null
        const metadata = getHappyChatMetadata(message)
        const event = metadata?.kind === 'event' ? metadata.event : undefined
        return event ? getEventPresentation(event).icon : null
    })

    if (role !== 'system') return null

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
