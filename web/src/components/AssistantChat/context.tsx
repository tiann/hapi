import type { ReactNode } from 'react'
import { createContext, useContext } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'

export type HappyChatContextValue = {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
}

const HappyChatContext = createContext<HappyChatContextValue | null>(null)

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    return (
        <HappyChatContext.Provider value={props.value}>
            {props.children}
        </HappyChatContext.Provider>
    )
}

export function useHappyChatContext(): HappyChatContextValue {
    const ctx = useContext(HappyChatContext)
    if (!ctx) {
        throw new Error('HappyChatContext is missing')
    }
    return ctx
}
