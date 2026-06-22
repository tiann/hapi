import { createContext, useContext, type ReactNode } from 'react'
import { usePwaUpdate } from '@/hooks/usePwaUpdate'

type PwaUpdateContextValue = ReturnType<typeof usePwaUpdate>

const PwaUpdateContext = createContext<PwaUpdateContextValue | null>(null)

export function PwaUpdateProvider({ children }: { children: ReactNode }) {
    const value = usePwaUpdate()

    return (
        <PwaUpdateContext.Provider value={value}>
            {children}
        </PwaUpdateContext.Provider>
    )
}

export function usePwaUpdateContext() {
    const value = useContext(PwaUpdateContext)
    if (!value) {
        throw new Error('usePwaUpdateContext must be used within PwaUpdateProvider')
    }
    return value
}
