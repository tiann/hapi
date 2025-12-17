import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'

export function HappySystemMessage() {
    const message = useAssistantState(({ message }) => message)
    if (message.role !== 'system') return null

    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''

    return (
        <MessagePrimitive.Root className="py-1">
            <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                {text}
            </div>
        </MessagePrimitive.Root>
    )
}

