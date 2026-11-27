import { describe, expect, it } from 'vitest'
import { queryKeys } from './query-keys'
import { getAppSseResyncQueryKeys } from './sseResync'

/** Mirrors tanstack-query's default prefix match, without standing up a client. */
function matchesPrefix(key: readonly unknown[], prefix: readonly unknown[]): boolean {
    return prefix.every((part, index) => key[index] === part)
}

describe('getAppSseResyncQueryKeys', () => {
    it('refreshes scratchlist membership and session tasks after a non-resumed reconnect', () => {
        expect(getAppSseResyncQueryKeys({ resumed: false }, false)).toEqual([
            queryKeys.sessions,
            queryKeys.scratchlistSessionIds,
            ['session'],
            ['session-tasks']
        ])
    })

    it('covers every session\'s task list and run history', () => {
        const keys = getAppSseResyncQueryKeys({ resumed: false }, false)
        expect(keys.some((prefix) => matchesPrefix(queryKeys.sessionTasks('session-1'), prefix))).toBe(true)
        expect(keys.some((prefix) => matchesPrefix(queryKeys.sessionTaskHistory('session-2'), prefix))).toBe(true)
        // The message window is recovered separately, not by this resync.
        expect(keys.some((prefix) => matchesPrefix(queryKeys.messages('session-1'), prefix))).toBe(false)
    })

    it('does not force a full resync when a reconnect was replayed', () => {
        expect(getAppSseResyncQueryKeys({ resumed: true }, false)).toEqual([])
    })

    it('still resyncs on the first connection', () => {
        expect(getAppSseResyncQueryKeys({ resumed: true }, true)).toContainEqual(queryKeys.scratchlistSessionIds)
    })
})
