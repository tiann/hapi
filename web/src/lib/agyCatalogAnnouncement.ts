import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

/**
 * Re-read one machine's agy catalog after it announced a newer listing.
 *
 * Cancelling first is not belt-and-braces: `invalidateQueries` leans on
 * `Query.fetch`, which cancels an in-flight request only when the query already
 * holds data, so a picker opening for the first time would instead join the
 * request already on its way and settle on the listing being superseded.
 * `cancelQueries` has no such condition, and is a no-op when nothing is in
 * flight.
 */
export async function applyAgyCatalogAnnouncement(
    queryClient: QueryClient,
    machineId: string
): Promise<void> {
    await refreshAgyCatalogs(queryClient, queryKeys.machineAgyModels(machineId))
}

/**
 * Re-read every machine's agy catalog after a reconnect the hub could not replay.
 * Announcements made during that gap are gone, so this is the only correction
 * those pickers get — and a picker that mounted mid-gap is exactly the data-less
 * in-flight case above.
 */
export async function refreshAllAgyCatalogs(queryClient: QueryClient): Promise<void> {
    await refreshAgyCatalogs(queryClient, ['machine-agy-models'])
}

async function refreshAgyCatalogs(queryClient: QueryClient, queryKey: readonly unknown[]): Promise<void> {
    await queryClient.cancelQueries({ queryKey })
    await queryClient.invalidateQueries({ queryKey })
}
