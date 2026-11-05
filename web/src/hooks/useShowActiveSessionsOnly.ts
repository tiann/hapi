import { useCallback } from 'react'
import { useSessionListView } from './useSessionListView'

/**
 * Settings-page view of the session list status filter: "active only" is the
 * Active status, so the switch and the list's sort/filter menu stay in sync.
 */
export function useShowActiveSessionsOnly(): {
    showActiveSessionsOnly: boolean
    setShowActiveSessionsOnly: (value: boolean) => void
} {
    const { view, setView } = useSessionListView()
    const setShowActiveSessionsOnly = useCallback((value: boolean) => {
        setView({ status: value ? 'active' : 'all' })
    }, [setView])
    return { showActiveSessionsOnly: view.status === 'active', setShowActiveSessionsOnly }
}
