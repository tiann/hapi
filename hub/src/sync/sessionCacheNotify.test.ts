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
        cache.setSessionLastNotify(id, { status: 'blocked', at: Date.now() + 1_000, note: 'still stuck' })
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

describe('importing a transcript does not reopen an answered blocker (#1717)', () => {
    it('derives the blocker from the imported conversation, not from import-time arrival', async () => {
        // An import replays historical rows through live ingestion, which is
        // the wrong shape twice over: the imported reply never passes through
        // the CLI delivery callback, so nothing clears the footer it answered;
        // and every imported row is stamped with the SAME hub arrival (import
        // time) while imported replies keep their historical invocation times,
        // so arrival cannot order them either. The conversation entered Blocked
        // on a footer its own transcript answers.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'import-answered',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const historical = Date.now() - 86_400_000
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needed a key' })

        // The transcript: blocked footer, the operator's reply, then an
        // assistant turn carrying no footer at all.
        const rows = [
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
                }
            }, undefined, null, historical),
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'here is the key' },
                meta: { sentFrom: 'webapp' }
            }, 'imported-reply', null, historical + 1_000),
            store.messages.addMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } }
                }
            }, undefined, null, historical + 2_000)
        ]
        store.messages.markMessagesInvoked(session.id, ['imported-reply'], historical + 1_000)

        // Replayed through live ingestion exactly as the importer does.
        for (const message of rows) {
            engine.handleRealtimeEvent({
                type: 'message-received',
                sessionId: session.id,
                message: {
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId,
                    content: message.content,
                    createdAt: message.createdAt,
                    receivedAt: message.receivedAt,
                    invokedAt: message.invokedAt
                }
            })
        }
        // Live ingestion alone leaves the answered footer standing.
        expect(engine.getSession(session.id)?.lastNotify?.status).toBe('blocked')

        engine.reconcileNotifySignalAfterImport(session.id)

        expect(engine.getSession(session.id)?.lastNotify ?? null).toBeNull()
    })

    it('keeps a genuinely unanswered footer from an imported transcript', async () => {
        // Positive control: reconciliation must not simply wipe the signal.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'import-unanswered',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const historical = Date.now() - 86_400_000
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'still needs a key' })

        // Reply FIRST, then the agent blocks and nobody answers.
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'off you go' },
            meta: { sentFrom: 'webapp' }
        }, 'early-reply', null, historical)
        store.messages.markMessagesInvoked(session.id, ['early-reply'], historical)
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
            }
        }, undefined, null, historical + 1_000)

        engine.reconcileNotifySignalAfterImport(session.id)

        expect(engine.getSession(session.id)?.lastNotify?.status).toBe('blocked')
        expect(engine.getSession(session.id)?.lastNotify?.note).toBe('still needs a key')
    })
})

describe('cancelling a queued prompt cannot suppress the next blocker (#1717)', () => {
    it('ingests a genuine footer after a higher-numbered scheduled prompt is cancelled', () => {
        // Insertion `seq` is allocated as MAX(seq)+1, so deleting the
        // highest-numbered row frees its number for the next message to reuse.
        // Any boundary expressed as a POSITION therefore covers rows that do
        // not exist yet: acknowledge prompt A while a future-scheduled prompt B
        // holds the top number, cancel B, and the next footer is born beneath
        // the boundary and silently rejected — the session never enters
        // Blocked. The boundary is a hub timestamp, which deletion cannot
        // rewind, so there is nothing here to reuse.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, { emit: (_event: SyncEvent) => {} } as EventPublisher)
        const session = cache.getOrCreateSession(
            'cancel-reuse',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        cache.markSessionActive(session.id)
        const now = Date.now()

        // Prompt A, delivered.
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'answer' },
            meta: { sentFrom: 'webapp' }
        }, 'prompt-a', null, now - 10_000, now - 10_000)
        // Prompt B, scheduled for later, taking the top seq.
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'later' },
            meta: { sentFrom: 'webapp' }
        }, 'prompt-b', now + 3_600_000, now - 9_000, now - 9_000)
        store.messages.markMessagesInvoked(session.id, ['prompt-a'], now - 8_000)
        cache.clearSessionLastNotify(session.id, now - 8_000)

        // B is cancelled, freeing its number.
        store.messages.cancelQueuedMessage(session.id, 'prompt-b')

        // The agent then genuinely blocks, and the new row reuses B's number.
        cache.setSessionLastNotify(session.id, {
            status: 'blocked', at: now - 1_000, note: 'needs a key', receivedAt: now - 1_000
        })

        expect(cache.getSession(session.id)?.lastNotify?.status).toBe('blocked')
        expect(cache.getSession(session.id)?.lastNotify?.note).toBe('needs a key')
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

    it('does not let an EARLIER destination reply answer a newer source footer', async () => {
        // `mergeSessionMessages` renumbers every destination row above every
        // source row, so position after a merge is synthetic: an earlier
        // destination prompt ends up "above" a later source footer and read as
        // proof it had answered it, dropping a blocker the merged transcript
        // still plainly contains. Hub arrival times are real and comparable
        // across both sides, so they say what actually happened.
        const { cache, store } = makeCache()
        const source = makeSession(cache, 'merge-order-source')
        const target = makeSession(cache, 'merge-order-target')
        const now = Date.now()

        // Destination prompt delivered FIRST, an hour ago.
        store.messages.addMessage(target, {
            role: 'user',
            content: { type: 'text', text: 'earlier, unrelated' },
            meta: { sentFrom: 'webapp' }
        }, 'early-reply', null, now - 3_600_000, now - 3_600_000)
        store.messages.markMessagesInvoked(target, ['early-reply'], now - 3_600_000)

        // Source blocked AFTER that, and nobody has answered it.
        cache.setSessionLastNotify(source, {
            status: 'blocked', at: now - 60_000, note: 'needs a key', receivedAt: now - 60_000
        })

        await cache.mergeSessionHistory(source, target, 'default')

        expect(cache.getSession(target)?.lastNotify?.status).toBe('blocked')
        expect(cache.getSession(target)?.lastNotify?.note).toBe('needs a key')
    })

    it('still lets a LATER destination reply answer the source footer', async () => {
        // The other direction, so the test above cannot pass on a merge that
        // simply never clears anything.
        const { cache, store } = makeCache()
        const source = makeSession(cache, 'merge-order-source-2')
        const target = makeSession(cache, 'merge-order-target-2')
        const now = Date.now()

        cache.setSessionLastNotify(source, {
            status: 'blocked', at: now - 60_000, note: 'needs a key', receivedAt: now - 60_000
        })
        // Delivered after the footer arrived: a genuine answer.
        store.messages.addMessage(target, {
            role: 'user',
            content: { type: 'text', text: 'here you go' },
            meta: { sentFrom: 'webapp' }
        }, 'late-reply', null, now - 30_000, now - 30_000)
        store.messages.markMessagesInvoked(target, ['late-reply'], now - 30_000)

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

    it('keeps a blocker whose runner clock predates the prompt that started the turn', async () => {
        // The reviewer's scenario: the runner is 30 seconds behind the hub, and
        // the turn the operator's prompt started ends blocked 10 seconds in.
        // The footer's runner timestamp is therefore 20 seconds BEFORE the
        // hub's invocation stamp for the prompt that caused it, so comparing
        // the two clocks concludes the prompt answered a footer it actually
        // provoked — and the blocker vanishes while sitting in the transcript.
        //
        // Ordered by position instead: the prompt was delivered at a seq below
        // the footer that followed it, so it cannot be its answer.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'backfill-skew',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const now = Date.now()
        const RUNNER_BEHIND = 30_000

        // The operator's prompt, delivered now by the hub's clock.
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'go on then' },
            meta: { sentFrom: 'webapp' }
        }, 'prompt-1', null, now - 1_000)
        store.messages.markMessagesInvoked(session.id, ['prompt-1'], now)

        // The turn it started ends blocked 10s later — but stamped by a runner
        // running 30s slow, so it reads as 20s BEFORE the prompt's delivery.
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs a key' })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
            }
        // Runner-stamped author time, hub-stamped arrival: it reached the hub
        // ten seconds after the prompt was delivered, which is the truth the
        // runner's slow clock hides.
        }, undefined, null, now + 10_000 - RUNNER_BEHIND, now + 10_000)

        expect(engine.backfillRecentNotifySignals({ now })).toBe(1)
        expect(engine.getSession(session.id)?.lastNotify?.status).toBe('blocked')
    })

    it('does not let a locally handled command answer a footer during reconciliation', async () => {
        // The live path already skips the clear for a command the CLI handled
        // itself, but the store still stamps the row's `invoked_at`, so every
        // path that re-derives "was this answered?" from the transcript later
        // — backfill, rewind, merge — read it as a delivered reply. The
        // disposition is persisted now, so they agree with the live decision.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'backfill-local-command',
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
        }, undefined, null, now - 10_000, now - 10_000)
        // `/model` — consumed and stamped, but handled inside the CLI.
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: '/model' },
            meta: { sentFrom: 'webapp' }
        }, 'slash-1', null, now - 5_000)
        store.messages.markMessagesInvoked(session.id, ['slash-1'], now - 5_000, { agentDelivered: false })

        expect(engine.backfillRecentNotifySignals({ now })).toBe(1)
        expect(engine.getSession(session.id)?.lastNotify?.status).toBe('blocked')
    })

    it('still lets a genuinely delivered reply answer a footer', async () => {
        // Positive control for both tests above: the scan must still stop at a
        // real reply, or they would pass on a predicate that never matches.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'backfill-answered',
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
        }, undefined, null, now - 10_000, now - 10_000)
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'here is the key' },
            meta: { sentFrom: 'webapp' }
        }, 'reply-1', null, now - 5_000, now - 5_000)
        store.messages.markMessagesInvoked(session.id, ['reply-1'], now - 5_000)

        expect(engine.backfillRecentNotifySignals({ now })).toBe(0)
        expect(engine.getSession(session.id)?.lastNotify ?? null).toBeNull()
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
