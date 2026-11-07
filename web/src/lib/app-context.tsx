import { createContext, useContext, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { getSearchHistoryKey, SearchHistoryProvider } from '@/lib/search-history'

type AppContextValue = {
    api: ApiClient
    token: string
    baseUrl: string
    titleSuggestionAvailable?: boolean
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppContextProvider(props: {
    value: AppContextValue
    children: ReactNode
}) {
    return (
        <AppContext.Provider value={props.value}>
            <SearchHistoryProvider storageKey={getSearchHistoryKey(props.value.baseUrl, props.value.token)}>
                {props.children}
            </SearchHistoryProvider>
        </AppContext.Provider>
    )
}

export function useAppContext(): AppContextValue {
    const context = useContext(AppContext)
    if (!context) {
        throw new Error('AppContext is not available')
    }
    return context
}
