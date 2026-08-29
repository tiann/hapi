import { useCallback, useEffect, useState } from 'react'

export type ConsumedMessageTarget = {
    sessionId: string
    messageId: string
    messageQuery?: string
}

export function useConsumedMessageTarget(
    sessionId: string,
    messageId?: string,
    messageQuery?: string
): {
    effectiveMessageId?: string
    effectiveMessageQuery?: string
    consume: () => void
    clear: () => void
} {
    const [consumedTarget, setConsumedTarget] = useState<ConsumedMessageTarget | null>(null)

    useEffect(() => {
        setConsumedTarget(null)
    }, [sessionId])

    const retainedTarget = consumedTarget?.sessionId === sessionId
        ? consumedTarget
        : null
    const effectiveMessageId = messageId ?? retainedTarget?.messageId
    const effectiveMessageQuery = messageId
        ? messageQuery
        : retainedTarget?.messageQuery
    const consume = useCallback(() => {
        if (messageId) {
            setConsumedTarget({ sessionId, messageId, messageQuery })
        }
    }, [messageId, messageQuery, sessionId])
    const clear = useCallback(() => {
        setConsumedTarget(null)
    }, [])

    return { effectiveMessageId, effectiveMessageQuery, consume, clear }
}
