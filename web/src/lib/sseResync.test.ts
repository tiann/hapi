import { describe, expect, it } from 'vitest'
import { queryKeys } from './query-keys'
import { getAppSseResyncQueryKeys } from './sseResync'

describe('getAppSseResyncQueryKeys', () => {
    it('refreshes scratchlist membership after a non-resumed reconnect', () => {
        expect(getAppSseResyncQueryKeys({ resumed: false }, false)).toEqual([
            queryKeys.sessions,
            queryKeys.scratchlistSessionIds,
            ['session']
        ])
    })

    it('does not force a full resync when a reconnect was replayed', () => {
        expect(getAppSseResyncQueryKeys({ resumed: true }, false)).toEqual([])
    })

    it('still resyncs on the first connection', () => {
        expect(getAppSseResyncQueryKeys({ resumed: true }, true)).toContainEqual(queryKeys.scratchlistSessionIds)
    })
})
