import { useCallback, useEffect, useState } from 'react'
import { createQuote, persistQuotes, readQuotes, QUOTES_MAX, type Quote } from '@/lib/quotes'

/**
 * useComposerQuotes —— 每 session 的引用列表状态。
 *
 * 跨 session 竞态防护与 use-scratchlist.ts 同构：把已加载的 sessionId 与
 * quotes 放进同一个 state 原子交换，并按「已加载的 sessionId」持久化。
 * 若按当前 prop 持久化，session 切换后、rehydrate effect 跑之前的那次
 * persist 会用旧 session 的数据覆盖新 session 的存储。
 */
export function useComposerQuotes(sessionId: string) {
    const [{ sessionId: loadedSessionId, quotes }, setState] = useState<{
        sessionId: string
        quotes: Quote[]
    }>(() => ({ sessionId, quotes: readQuotes(sessionId) }))

    useEffect(() => {
        setState({ sessionId, quotes: readQuotes(sessionId) })
    }, [sessionId])

    useEffect(() => {
        persistQuotes(loadedSessionId, quotes)
    }, [loadedSessionId, quotes])

    const add = useCallback((text: string, messageId: string) => {
        setState((prev) => {
            if (prev.quotes.length >= QUOTES_MAX) return prev
            return { sessionId: prev.sessionId, quotes: [...prev.quotes, createQuote(text, messageId)] }
        })
    }, [])

    const remove = useCallback((id: string) => {
        setState((prev) => ({
            sessionId: prev.sessionId,
            quotes: prev.quotes.filter((q) => q.id !== id),
        }))
    }, [])

    const clear = useCallback(() => {
        setState((prev) => (prev.quotes.length === 0 ? prev : { sessionId: prev.sessionId, quotes: [] }))
    }, [])

    return { quotes, add, remove, clear }
}
