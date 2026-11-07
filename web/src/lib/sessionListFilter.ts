export type SessionListFilter = 'all' | 'unread' | 'scratchlist'

export type SessionListFilterState = {
    unread: boolean
    scratchlist: boolean
}

export const DEFAULT_SESSION_LIST_FILTER_STATE: SessionListFilterState = {
    unread: false,
    scratchlist: false
}

export const SESSION_LIST_FILTER_OPTIONS = [
    { value: 'unread', labelKey: 'sessions.filter.unread' },
    { value: 'scratchlist', labelKey: 'sessions.filter.scratchlist' },
] as const satisfies ReadonlyArray<{ value: Exclude<SessionListFilter, 'all'>; labelKey: string }>

export function isSessionListFilterSelected(
    state: SessionListFilterState,
    filter: Exclude<SessionListFilter, 'all'>
): boolean {
    return state[filter]
}

export function toggleSessionListFilter(
    state: SessionListFilterState,
    filter: Exclude<SessionListFilter, 'all'>
): SessionListFilterState {
    return {
        ...state,
        [filter]: !state[filter]
    }
}
