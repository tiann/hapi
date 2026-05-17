import type { ParsedLocation } from '@tanstack/react-router'

const FILE_ROUTE = /^\/sessions\/[^/]+\/file$/
const FILES_ROUTE = /^\/sessions\/[^/]+\/files$/

/**
 * Derive the cache key TanStack Router uses to remember scroll positions.
 *
 * The default key (`location.state.__TSR_key`) is unique per history entry,
 * so the cache grows without bound across navigations and eventually exhausts
 * `sessionStorage` (~5 MB → QuotaExceededError that blocks React commit;
 * see tiann/hapi#611).
 *
 * Returning `location.pathname` collapses navigations to the same route into
 * one bucket. Routes whose visible content is identified by a search param
 * (file diff path, files tab) include the relevant param so per-file/per-tab
 * scroll positions are still remembered.
 */
export function getScrollRestorationKey(location: ParsedLocation): string {
    const search = location.search as {
        path?: unknown
        staged?: unknown
        tab?: unknown
        machineId?: unknown
    }
    if (FILE_ROUTE.test(location.pathname) && typeof search.path === 'string') {
        const stagedSuffix = search.staged === true ? '&staged=true' : ''
        return `${location.pathname}?path=${search.path}${stagedSuffix}`
    }
    if (FILES_ROUTE.test(location.pathname) && search.tab === 'directories') {
        return `${location.pathname}?tab=directories`
    }
    if (location.pathname === '/browse' && typeof search.machineId === 'string') {
        return `${location.pathname}?machineId=${search.machineId}`
    }
    return location.pathname
}
