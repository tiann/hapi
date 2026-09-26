import { useCallback, useEffect, useRef, useState } from 'react'

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
    searchRequestId: number
    consume: () => void
    clear: () => void
} {
    const [consumedTarget, setConsumedTarget] = useState<ConsumedMessageTarget | null>(null)
    const previousInputKeyRef = useRef<string | null>(null)
    const searchRequestIdRef = useRef(0)

    const inputKey = messageId
        ? `${sessionId}\u0000${messageId}\u0000${messageQuery ?? ''}`
        : null
    if (inputKey !== previousInputKeyRef.current) {
        previousInputKeyRef.current = inputKey
        if (inputKey !== null) searchRequestIdRef.current += 1
    }

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

    return {
        effectiveMessageId,
        effectiveMessageQuery,
        searchRequestId: searchRequestIdRef.current,
        consume,
        clear
    }
}
