import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function makeCache(): { cache: SessionCache; store: Store } {
    const store = new Store(':memory:')
    const cache = new SessionCache(store, { emit: (_event: SyncEvent) => {} } as EventPublisher)
    return { cache, store }
}

function seedBlocked(cache: SessionCache, tag: string): string {
    const session = cache.getOrCreateSession(
        tag,
        { path: '/tmp/project', host: 'localhost' },
        null,
        'default'
    )
    cache.markSessionActive(session.id)
    cache.setSessionLastNotify(session.id, { status: 'blocked', at: Date.now(), note: 'needs creds' })
    expect(cache.getSession(session.id)?.lastNotify?.status).toBe('blocked')
    return session.id
}

describe('lastNotify clearing on turn start (#1717)', () => {
    it('keeps the footer while the prompt is only QUEUED, clears on delivery', () => {
        // Queueing is optimistic: an idempotent retry of an already-consumed
        // message reuses its row and starts no turn, and a prompt can be
        // cancelled before the agent ever sees it. Clearing here erased live
        // blockers in both cases, so the clear lives on confirmed delivery.
        const { cache } = makeCache()
        const id = seedBlocked(cache, 'notify-clear-queued')

        cache.markMessageQueued(id)
        expect(cache.getSession(id)?.lastNotify?.status).toBe('blocked')

        cache.clearSessionLastNotify(id)
        expect(cache.getSession(id)?.lastNotify).toBeNull()
    })

    it('clears when the CLI reports the agent started thinking', () => {
        const { cache } = makeCache()
        const id = seedBlocked(cache, 'notify-clear-alive')

        cache.handleSessionAlive({ sid: id, time: Date.now(), thinking: true })

        expect(cache.getSession(id)?.lastNotify).toBeNull()
    })

    it('keeps the footer while the session stays idle', () => {
        const { cache } = makeCache()
        const id = seedBlocked(cache, 'notify-keep-idle')

        cache.handleSessionAlive({ sid: id, time: Date.now(), thinking: false })

        expect(cache.getSession(id)?.lastNotify?.status).toBe('blocked')
    })

    it('does not re-clear on every keep-alive of an already-thinking session', () => {
        const { cache } = makeCache()
        const id = seedBlocked(cache, 'notify-keep-thinking')
        cache.handleSessionAlive({ sid: id, time: Date.now(), thinking: true })

        // A footer arriving mid-turn must survive later keep-alives that carry
        // no rising edge, or a blocked report would be erased the moment the
        // next keep-alive tick lands.
        cache.setSessionLastNotify(id, { status: 'blocked', at: Date.now(), note: 'still stuck' })
        cache.handleSessionAlive({ sid: id, time: Date.now(), thinking: true })

        expect(cache.getSession(id)?.lastNotify?.status).toBe('blocked')
    })
})

describe('footer timestamp boundary on the live path (#1717)', () => {
    it('rejects a delayed footer stamped before the operator reply', () => {
        // `clearSessionLastNotify` nulls `last_notify_at`, so the store's
        // monotonic check has nothing to compare against, and Claude replays
        // keep their original timestamps. The turn that cleared it is the
        // boundary — anything older was answered by the prompt that started it.
        const { cache } = makeCache()
        const id = seedBlocked(cache, 'notify-boundary')
        const beforeReply = Date.now() - 60_000

        cache.markMessageQueued(id)
        cache.clearSessionLastNotify(id)
        expect(cache.getSession(id)?.lastNotify).toBeNull()

        cache.setSessionLastNotify(id, { status: 'blocked', at: beforeReply, note: 'stale replay' })

        expect(cache.getSession(id)?.lastNotify ?? null).toBeNull()
    })

    it('rejects a delayed footer that arrives after the reply turn ended', () => {
        // The gap the earlier `activeTurnStartedAt` version missed: that field
        // resets when the agent goes idle, so once the turn ends both it and
        // `last_notify_at` are null and the stale footer was accepted. The
        // persisted clear watermark has to outlive the turn.
        const { cache } = makeCache()
        const id = seedBlocked(cache, 'notify-boundary-after-turn')
        const beforeReply = Date.now() - 60_000

        cache.markMessageQueued(id)
        cache.clearSessionLastNotify(id)
        // Turn ends; agent goes idle without emitting another footer.
        cache.handleSessionEnd({ sid: id, time: Date.now() })

        cache.setSessionLastNotify(id, { status: 'blocked', at: beforeReply, note: 'stale replay' })

        expect(cache.getSession(id)?.lastNotify ?? null).toBeNull()
    })

    it('still accepts a footer from the current turn', () => {
        const { cache } = makeCache()
        const id = seedBlocked(cache, 'notify-boundary-live')

        cache.markMessageQueued(id)
        cache.clearSessionLastNotify(id)
        cache.setSessionLastNotify(id, { status: 'blocked', at: Date.now() + 1_000, note: 'stuck again' })

        expect(cache.getSession(id)?.lastNotify?.note).toBe('stuck again')
    })
})

describe('notify revision is whatever SQLite says (#1717)', () => {
    it('never broadcasts a revision the row does not hold', () => {
        // The browser orders notify/ack payloads by `notifyUpdatedAt`, so the
        // hub must have exactly one counter. SQLite versions a clear off the
        // *boundary* timestamp — the answering message's clock, usually well in
        // the past — while this path used to invent `Date.now()`. The patch
        // then outran the row, and the next refresh looked older than a payload
        // the browser had already applied, so it was dropped. In a merge that
        // dropped payload is the one carrying the transferred dismissal, and a
        // row the operator had marked unblocked went back to blocked.
        const store = new Store(':memory:')
        const emitted: SyncEvent[] = []
        const cache = new SessionCache(store, { emit: (event: SyncEvent) => { emitted.push(event) } } as EventPublisher)
        const id = seedBlocked(cache, 'notify-revision')

        emitted.length = 0
        // The two counters only diverge once the clock has moved since the
        // footer was stored: SQLite then advances the row by one from its own
        // value while a now-based bump jumps the whole elapsed interval ahead.
        // Any real gap between an agent reporting blocked and the operator
        // answering is enormously longer than this.
        const until = Date.now() + 3
        while (Date.now() < until) { /* advance the clock deterministically */ }

        // A reply delivered an hour ago: the boundary SQLite versions the
        // clear from is in the past, so the row cannot reach hub-now.
        cache.clearSessionLastNotify(id, Date.now() - 3_600_000)

        const row = store.sessions.getSessionByNamespace(id, 'default')
        const patch = emitted
            .filter((event) => event.type === 'session-updated')
            .map((event) => (event as { data: { notifyUpdatedAt?: number } }).data)
            .at(-1)
        expect(row?.lastNotifyUpdatedAt).toBeGreaterThan(0)
        expect(patch?.notifyUpdatedAt).toBe(row!.lastNotifyUpdatedAt!)
        expect(cache.getSession(id)?.notifyUpdatedAt).toBe(row!.lastNotifyUpdatedAt!)
    })
})

describe('blocked acknowledgement across a session merge (#1717)', () => {
    function makeSession(cache: SessionCache, tag: string): string {
        return cache.getOrCreateSession(
            tag,
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        ).id
    }

    it('carries the source acknowledgement onto the merged row', async () => {
        // The merge moves the source's pending requests across with their
        // original timestamps. Without the watermark they read as newer than
        // nothing and a prompt the operator already dismissed blocks again.
        const { cache } = makeCache()
        const source = makeSession(cache, 'merge-ack-source')
        const target = makeSession(cache, 'merge-ack-target')
        const ackAt = Date.now()
        cache.setSessionBlockedAck(source, 'handled out of band', ackAt)

        await cache.mergeSessionHistory(source, target, 'default')

        expect(cache.getSession(target)?.blockedAck?.at).toBe(ackAt)
        expect(cache.getSession(target)?.blockedAck?.reason).toBe('handled out of band')
    })

    it('carries the blocked footer onto the merged row', async () => {
        // `mergeSessionMessages` moves the blocked turn across but replays no
        // `message-added`, so nothing re-derives the signal on the target: the
        // conversation would keep the unanswered footer in its transcript and
        // still vanish from the Blocked section.
        const { cache } = makeCache()
        const source = makeSession(cache, 'merge-notify-source')
        const target = makeSession(cache, 'merge-notify-target')
        const at = Date.now()
        cache.setSessionLastNotify(source, { status: 'blocked', at, note: 'needs a key' })

        await cache.mergeSessionHistory(source, target, 'default')

        expect(cache.getSession(target)?.lastNotify?.status).toBe('blocked')
        expect(cache.getSession(target)?.lastNotify?.note).toBe('needs a key')
    })

    it('does not resurrect a footer the destination already answered', async () => {
        // The destination's notify is null because `markMessageQueued` cleared
        // it when the operator replied — not because it never had one. Copying
        // the source's older footer over that would un-answer a blocker.
        const { cache, store } = makeCache()
        const source = makeSession(cache, 'merge-answered-source')
        const target = makeSession(cache, 'merge-answered-target')
        const now = Date.now()
        cache.setSessionLastNotify(source, { status: 'blocked', at: now - 10_000, note: 'stale' })
        store.messages.addMessage(target, {
            role: 'user',
            content: { type: 'text', text: 'here you go' },
            meta: { sentFrom: 'webapp' }
        }, 'reply-1', null, now)
        // Delivered, not merely queued: an uninvoked prompt has not reached
        // the agent and must not count as an answer.
        store.messages.markMessagesInvoked(target, ['reply-1'], now)

        await cache.mergeSessionHistory(source, target, 'default')

        expect(cache.getSession(target)?.lastNotify ?? null).toBeNull()
    })

    it('finds the answering reply even when it came from the source side', async () => {
        // The reply that answered the source's footer is on the SOURCE, and
        // `mergeSessionMessages` renumbers every destination row ABOVE every
        // source row. A recency-bounded scan of the merged transcript therefore
        // reads back nothing but destination chatter, however much of it there
        // is, and concludes nothing answered the footer — so it carries a
        // blocker onto the merged row that the combined transcript answers.
        // Seq order is not time order after a merge, so the scan cannot be
        // bounded by seq at all.
        const { cache, store } = makeCache()
        const source = makeSession(cache, 'merge-scan-source')
        const target = makeSession(cache, 'merge-scan-target')
        const now = Date.now()

        cache.setSessionLastNotify(source, { status: 'blocked', at: now - 10_000, note: 'stale' })
        store.messages.addMessage(source, {
            role: 'user',
            content: { type: 'text', text: 'here you go' },
            meta: { sentFrom: 'webapp' }
        }, 'source-reply', null, now - 5_000)
        store.messages.markMessagesInvoked(source, ['source-reply'], now - 5_000)

        // Enough destination traffic to fill any fixed window on its own.
        for (let i = 0; i < 8; i++) {
            store.messages.addMessage(target, {
                role: 'agent',
                content: { type: 'text', text: `working ${i}` }
            }, `target-${i}`, null, now - 4_000 + i)
        }

        await cache.mergeSessionHistory(source, target, 'default')

        expect(cache.getSession(target)?.lastNotify ?? null).toBeNull()
    })

    it('keeps the newer footer when both rows have one', async () => {
        const { cache } = makeCache()
        const source = makeSession(cache, 'merge-notify-old')
        const target = makeSession(cache, 'merge-notify-new')
        const now = Date.now()
        cache.setSessionLastNotify(source, { status: 'blocked', at: now - 10_000, note: 'older' })
        cache.setSessionLastNotify(target, { status: 'blocked', at: now, note: 'newer' })

        await cache.mergeSessionHistory(source, target, 'default')

        expect(cache.getSession(target)?.lastNotify?.note).toBe('newer')
    })

    it('keeps the newer acknowledgement when both rows have one', async () => {
        const { cache } = makeCache()
        const source = makeSession(cache, 'merge-ack-older-source')
        const target = makeSession(cache, 'merge-ack-newer-target')
        const now = Date.now()
        cache.setSessionBlockedAck(source, 'older', now - 10_000)
        cache.setSessionBlockedAck(target, 'newer', now)

        await cache.mergeSessionHistory(source, target, 'default')

        expect(cache.getSession(target)?.blockedAck?.reason).toBe('newer')
    })
})

describe('future-scheduled messages leave the blocker alone (#1717)', () => {
    it('keeps the footer when a reply is scheduled for later, and clears it on an immediate send', async () => {
        // `MessageService.sendMessage` withholds a future-scheduled message
        // from the CLI, so the agent has not been given the reply. Clearing
        // the footer here would erase a blocker nobody answered — and
        // cancelling the schedule would leave it erased.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'scheduled-blocked',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const cache = (engine as unknown as { sessionCache: SessionCache }).sessionCache
        cache.markSessionActive(session.id)

        const seed = () => cache.setSessionLastNotify(
            session.id,
            { status: 'blocked', at: Date.now(), note: 'needs a decision' }
        )

        seed()
        await engine.sendMessage(session.id, { text: 'later', scheduledAt: Date.now() + 3_600_000 })
        expect(cache.getSession(session.id)?.lastNotify?.status).toBe('blocked')

        // Control: an immediate send reaches the agent, and the CLI's
        // confirmed consumption is what clears the footer.
        seed()
        await engine.sendMessage(session.id, { text: 'now' })
        engine.clearSessionLastNotifyOnDelivery(session.id)
        expect(cache.getSession(session.id)?.lastNotify).toBeNull()
    })
})

describe('startup notify backfill (#1717)', () => {
    it('does not treat a future-scheduled reply as an answer', async () => {
        // `MessageService.sendMessage` withholds a future-scheduled message
        // from the agent, so it has answered nothing. Stopping the scan on it
        // buries an unanswered footer on restart — the same blind spot the
        // live path had at `markMessageQueued`.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'backfill-scheduled',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const now = Date.now()
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs a key' })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
            }
        }, undefined, null, now - 1_000)
        // Queued for an hour from now: the agent has not seen it.
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'here is the key' },
            meta: { sentFrom: 'webapp' }
        }, 'later-1', now + 3_600_000, now)

        const stamped = engine.backfillRecentNotifySignals({ now })

        expect(stamped).toBe(1)
        expect(engine.getSession(session.id)?.lastNotify?.status).toBe('blocked')
    })

    it('does not treat an overdue but never-invoked reply as an answer', async () => {
        // Due time is not delivery. A scheduled reply can pass its due time
        // while the agent is offline and still have a null invokedAt — the
        // agent never saw it, so the blocker it was meant to answer stands.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'backfill-overdue',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const now = Date.now()
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs a key' })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
            }
        }, undefined, null, now - 10_000)
        // Due an hour ago, never invoked: the agent was offline throughout.
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'here is the key' },
            meta: { sentFrom: 'webapp' }
        }, 'overdue-1', now - 3_600_000, now - 5_000)

        expect(engine.backfillRecentNotifySignals({ now })).toBe(1)
        expect(engine.getSession(session.id)?.lastNotify?.status).toBe('blocked')
    })
})
