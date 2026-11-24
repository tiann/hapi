import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

// `thinkingRevision`'s zero-exception (#1717 bot review) only covers the
// instant nothing has ticked yet after a restart; `hubGeneration` is what
// lets a client detect a restart happened at all, regardless of what any
// one session's counter reads at that moment — see the field's own doc
// comment on `SessionCache` for the full race it closes.
describe('SessionCache.hubGeneration (#1717 cold-review round 29)', () => {
    const publisher = { emit: (_event: SyncEvent) => {} } as unknown as EventPublisher

    it('is stable across reads of the same instance', () => {
        const cache = new SessionCache(new Store(':memory:'), publisher)
        expect(cache.hubGeneration).toBe(cache.hubGeneration)
    })

    it('differs between two instances, simulating two hub processes', () => {
        const first = new SessionCache(new Store(':memory:'), publisher)
        const second = new SessionCache(new Store(':memory:'), publisher)
        expect(first.hubGeneration).not.toBe(second.hubGeneration)
    })
})
