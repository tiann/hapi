import { useAssistantState } from '@assistant-ui/react'
import { formatMessageTimestamp, formatMessageTimestampTitle } from '@/chat/presentation'

type MessageTimestampProps = {
    className?: string
}

export function MessageTimestamp(props: MessageTimestampProps) {
    const createdAt = useAssistantState(({ message }) => message.createdAt)

    return (
        <time
            dateTime={createdAt.toISOString()}
            title={formatMessageTimestampTitle(createdAt)}
            className={props.className}
        >
            {formatMessageTimestamp(createdAt)}
        </time>
    )
}
