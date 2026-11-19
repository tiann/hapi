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
    it('clears when the operator sends a message', () => {
        // markMessageQueued sets thinking=true itself, before any CLI
        // keep-alive lands — so a rising-edge check in handleSessionAlive
        // alone would never fire for the reply path and the stale "Blocked"
        // chrome would survive the operator answering.
        const { cache } = makeCache()
        const id = seedBlocked(cache, 'notify-clear-queued')

        cache.markMessageQueued(id)

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

        // Control: an immediate send really does reach the agent, so it clears.
        seed()
        await engine.sendMessage(session.id, { text: 'now' })
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
})
