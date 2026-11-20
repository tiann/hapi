import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { SessionBlockedAckSchema } from '@hapi/protocol/schemas'
import { Store } from '../store'
import { ACK_KEYS_RETENTION_LIMIT } from '../store/sessions'
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
        // Written exactly as the importer writes them — `addImportedMessage`,
        // not `addMessage`. Using the live insert here modelled an import that
        // does not exist: it stamps arrival at `now` while the importer stamps
        // the transcript's own time, which is the whole distinction the
        // reconciliation turns on.
        const rows = [
            store.messages.addImportedMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
                }
            }, 'imported-footer', historical).message,
            store.messages.addImportedMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'here is the key' },
                meta: { sentFrom: 'webapp' }
            }, 'imported-reply', historical + 1_000).message,
            store.messages.addImportedMessage(session.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } }
                }
            }, 'imported-tail', historical + 2_000).message
        ]

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

    it('does not reopen an answered imported blocker when a rewind retains it', async () => {
        // The reviewer's sequence: import (footer, reply, footerless reply),
        // resume, send another prompt, then rewind to that prompt so the
        // imported prefix survives. Rewind reconciliation re-derives from the
        // retained transcript — and an imported row used to carry the
        // transcript's time in `invoked_at` but IMPORT time in `received_at`,
        // so the imported footer looked newer than the imported reply that
        // answered it and the replacement write reopened the blocker.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'import-then-rewind',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const historical = Date.now() - 86_400_000
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needed a key' })

        // Imported prefix, written the way the importer writes it.
        store.messages.addImportedMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
            }
        }, 'imported-footer', historical)
        store.messages.addImportedMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'here is the key' },
            meta: { sentFrom: 'webapp' }
        }, 'imported-reply', historical + 1_000)
        store.messages.addImportedMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } }
            }
        }, 'imported-tail', historical + 2_000)

        // What the rewind reconciliation does with the retained prefix.
        engine.reconcileNotifySignalAfterImport(session.id)

        expect(engine.getSession(session.id)?.lastNotify ?? null).toBeNull()
    })

    it('keeps an unanswered footer when the import has no timestamps at all', async () => {
        // A Codex Desktop transcript carries no per-message timestamps, so the
        // importer stamps every row with the same import time. Comparing
        // arrival alone then made the transcript's FINAL message — an
        // unanswered blocked footer — compare equal to the prompt that started
        // it and read as already answered, so the conversation went missing
        // from Blocked entirely. Native transcript order breaks the tie.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'import-no-timestamps',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const importedAt = Date.now()
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs a decision' })

        // Prompt first, then the footer — same timestamp, order carried by seq.
        store.messages.addImportedMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'off you go' },
            meta: { sentFrom: 'webapp' }
        }, 'codex-prompt', importedAt)
        store.messages.addImportedMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
            }
        }, 'codex-footer', importedAt)

        engine.reconcileNotifySignalAfterImport(session.id)

        expect(engine.getSession(session.id)?.lastNotify?.status).toBe('blocked')
        expect(engine.getSession(session.id)?.lastNotify?.note).toBe('needs a decision')
    })

    it('keeps the final blocker of a MULTI-TURN untimestamped import', async () => {
        // Two turns, no timestamps anywhere: the importer stamps every row
        // identically. The first turn's footer then sets an author cutoff
        // EQUAL to the final footer's author time, and an at-or-older
        // comparison discarded a blocker that is both unanswered and the last
        // thing in the transcript. Where the author clock cannot discriminate,
        // position already has.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'import-two-turns',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const importedAt = Date.now()
        const footerText = (status: string, summary: string) => 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status, summary })
        const agent = (text: string) => ({
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text }] } }
            }
        })

        // Turn one: blocked, then answered.
        store.messages.addImportedMessage(session.id, agent(footerText('blocked', 'turn one')), 'f1', importedAt)
        store.messages.addImportedMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'here you go' },
            meta: { sentFrom: 'webapp' }
        }, 'p1', importedAt)
        // Turn two: the operator prompts again, and it ends blocked.
        store.messages.addImportedMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'now this' },
            meta: { sentFrom: 'webapp' }
        }, 'p2', importedAt)
        store.messages.addImportedMessage(session.id, agent(footerText('blocked', 'turn two')), 'f2', importedAt)

        engine.reconcileNotifySignalAfterImport(session.id)

        expect(engine.getSession(session.id)?.lastNotify?.status).toBe('blocked')
        expect(engine.getSession(session.id)?.lastNotify?.note).toBe('turn two')
    })

    it('keeps the final blocker when both turns report the SAME footer text', async () => {
        // The round-14 identity check keyed on the footer's text, and an
        // untimestamped import gives every row one timestamp — so two distinct
        // turns reporting the same status and note collapsed to one identity
        // and the second was discarded as a replay. My own multi-turn test
        // used different notes, so it could not see this. An imported row
        // carries the transcript's message id, which says they are two
        // different messages however identical their text.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'import-identical-footers',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const importedAt = Date.now()
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs a key' })
        const agent = () => ({
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
            }
        })

        store.messages.addImportedMessage(session.id, agent(), 'f1', importedAt)
        store.messages.addImportedMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'here you go' },
            meta: { sentFrom: 'webapp' }
        }, 'p1', importedAt)
        // Identical text to the first footer, but a different turn.
        store.messages.addImportedMessage(session.id, agent(), 'f2', importedAt)

        engine.reconcileNotifySignalAfterImport(session.id)

        expect(engine.getSession(session.id)?.lastNotify?.status).toBe('blocked')
    })

    it('rejects an EXACT replay of an answered footer on rewind', async () => {
        // Claude transcript rows keep their author timestamp and arrive with
        // no outer local id, so the same footer can be stored a second time
        // after the reply that answered it. Live ingestion refuses it on the
        // equal author timestamp — but making the reconciliation comparison
        // strict (so untimestamped imports could work at all) meant an equal
        // author time now PASSED there. Identity is what separates the two: a
        // replay is the same status, note and timestamp as something already
        // superseded; a new footer in an untimestamped import is not.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'rewind-exact-replay',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const base = Date.now() - 600_000
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs a key' })
        const agentFooter = () => ({
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
            }
        })

        store.messages.addMessage(session.id, agentFooter(), undefined, null, base, base)
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'here you go' },
            meta: { sentFrom: 'webapp' }
        }, 'reply-1', null, base + 1_000, base + 1_000)
        store.messages.markMessagesInvoked(session.id, ['reply-1'], base + 2_000)
        // The SAME footer stored again, after the reply.
        store.messages.addMessage(session.id, agentFooter(), undefined, null, base, base + 3_000)

        engine.reconcileNotifySignalAfterImport(session.id)

        expect(engine.getSession(session.id)?.lastNotify ?? null).toBeNull()
    })

    it('uses hub arrival for a LOCAL reply, whose invokedAt is the runner clock', async () => {
        // A prompt typed straight into a local Claude terminal never went
        // through the hub queue, so it has no local id and `invoked_at` is the
        // transcript's own clock. Measuring that against a footer's hub
        // arrival is the cross-clock comparison this area exists to avoid: on
        // a slow-enough runner a LATER local reply sorted before an EARLIER
        // footer's arrival, and a rewind retaining both restored a blocker the
        // operator had already answered.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'rewind-local-reply',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const hubNow = Date.now()
        const RUNNER_BEHIND = 3_600_000
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs a key' })

        // Footer: arrived at the hub an hour ago by the hub's clock.
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
            }
        }, undefined, null, hubNow - RUNNER_BEHIND, hubNow - 60_000)
        // Local reply, answering it: no localId, so its invokedAt is the
        // runner's clock and reads as an hour BEFORE the footer's arrival.
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'here you go' },
            meta: { sentFrom: 'cli' }
        }, undefined, null, hubNow - RUNNER_BEHIND + 1_000, hubNow)

        engine.reconcileNotifySignalAfterImport(session.id)

        expect(engine.getSession(session.id)?.lastNotify ?? null).toBeNull()
    })

    it('persists the replay cutoff across a rewind, so a late footer still cannot return', async () => {
        // Reconciliation computes an author cutoff from the retained history,
        // and the replacement write used to reset it to null. A footer from
        // the retained, already-answered turn that reaches the hub for the
        // FIRST time after the rewind then arrives fresh, so arrival cannot
        // reject it and only the cutoff can.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'rewind-cutoff',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const base = Date.now() - 600_000
        const footerText = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'original' })

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footerText }] } }
            }
        }, undefined, null, base, base)
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'here you go' },
            meta: { sentFrom: 'webapp' }
        }, 'reply-1', null, base + 1_000, base + 1_000)
        store.messages.markMessagesInvoked(session.id, ['reply-1'], base + 2_000)

        // The rewind retains the footer and the reply that answered it.
        engine.reconcileNotifySignalAfterImport(session.id)
        expect(engine.getSession(session.id)?.lastNotify ?? null).toBeNull()
        const row = store.sessions.getSessionByNamespace(session.id, 'default')
        expect(row?.lastNotifyClearedAuthorAt).toBe(base)

        // A footer from that answered turn, arriving only now.
        engine.getSession(session.id)
        engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: {
                id: 'late-1',
                seq: 99,
                localId: null,
                createdAt: base - 5_000,
                receivedAt: Date.now(),
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: { type: 'assistant', message: { content: [{ type: 'text', text: footerText }] } }
                    }
                }
            }
        })

        expect(engine.getSession(session.id)?.lastNotify ?? null).toBeNull()
    })

    it('does not restore, on rewind, a replay that live ingestion rejected', async () => {
        // Live ingestion rejects an older footer replay using the author time
        // of the footer the reply superseded — but that cutoff is SESSION
        // state, so a derivation reading only the transcript cannot see it.
        // Rewind retaining both the reply and the replay therefore handed the
        // replay back as the blocker, reopening an answered turn. The
        // transcript carries the equivalent: a footer that arrived before the
        // reply belongs to a turn the reply superseded, so nothing authored at
        // or before it can be current.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'rewind-replay',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )
        const base = Date.now() - 600_000
        const footerAt = (at: number, summary: string) => 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary })

        // The agent blocked, and the operator answered.
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footerAt(base, 'original') }] } }
            }
        }, undefined, null, base, base)
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'here you go' },
            meta: { sentFrom: 'webapp' }
        }, 'reply-1', null, base + 1_000, base + 1_000)
        store.messages.markMessagesInvoked(session.id, ['reply-1'], base + 2_000)
        // A delayed replay of that same, already-answered turn: authored
        // BEFORE the original footer, but reaching the hub after the reply.
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footerAt(base, 'stale replay') }] } }
            }
        }, undefined, null, base - 5_000, base + 3_000)

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

describe('transferBlockedAck across a merge that copies its own messages (#1717)', () => {
    it('carries the dismissal onto the canonical session', () => {
        // The Codex Desktop duplicate reconciliation copies a duplicate's
        // messages into the canonical session and then deletes the source. It
        // never transferred the acknowledgement, so a footer the operator had
        // already dismissed became the canonical session's latest signal and
        // reappeared in Blocked — their decision undone by a merge they never
        // asked for.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, { emit: (_e: SyncEvent) => {} } as EventPublisher)
        const duplicate = cache.getOrCreateSession('dup', { path: '/tmp', host: 'h' }, null, 'default')
        const canonical = cache.getOrCreateSession('canon', { path: '/tmp', host: 'h' }, null, 'default')
        const at = Date.now()
        cache.setSessionBlockedAck(duplicate.id, 'handled out of band', at, 'notify:1000')

        cache.transferBlockedAck(duplicate.id, canonical.id, 'default')

        const row = store.sessions.getSessionByNamespace(canonical.id, 'default')
        expect(row?.blockedAckKeys).toEqual(['notify:1000'])
        expect(row?.blockedAckReason).toBe('handled out of band')
    })

    it('unions the two sets rather than replacing either', () => {
        // Each side having dismissed a DIFFERENT prompt must not make either
        // block again on the merged row.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, { emit: (_e: SyncEvent) => {} } as EventPublisher)
        const duplicate = cache.getOrCreateSession('dup2', { path: '/tmp', host: 'h' }, null, 'default')
        const canonical = cache.getOrCreateSession('canon2', { path: '/tmp', host: 'h' }, null, 'default')
        const at = Date.now()
        cache.setSessionBlockedAck(duplicate.id, 'theirs', at - 1_000, 'request:a')
        cache.setSessionBlockedAck(canonical.id, 'ours', at, 'request:b')

        cache.transferBlockedAck(duplicate.id, canonical.id, 'default')

        const keys = store.sessions.getSessionByNamespace(canonical.id, 'default')?.blockedAckKeys ?? []
        expect([...keys].sort()).toEqual(['request:a', 'request:b'])
    })

    it('carries arrival and delivery across a message copy, so the pair stays ordered', () => {
        // The duplicate merge copies a footer AND the reply that answered it.
        // Re-stamping arrival at copy time made every copied row look like it
        // reached the hub now, so the footer no longer sat before its answer —
        // and with the copied reply never passing through the delivery
        // callback, the canonical row entered Blocked on a footer its own
        // combined transcript answers.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, { emit: (_e: SyncEvent) => {} } as EventPublisher)
        const session = cache.getOrCreateSession('copy-order', { path: '/tmp', host: 'h' }, null, 'default')
        const base = Date.now() - 600_000

        const copied = store.messages.copyMessageToSession(session.id, {
            content: { role: 'user', content: { type: 'text', text: 'here you go' }, meta: { sentFrom: 'webapp' } },
            createdAt: base,
            localId: null,
            invokedAt: base + 1_000,
            scheduledAt: null,
            deliveryState: undefined,
            receivedAt: base,
            agentDelivered: 1
        })

        expect(copied.receivedAt).toBe(base)
        expect(copied.agentDelivered).toBe(1)
    })

    it('falls back to createdAt when copying history written before the column existed', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, { emit: (_e: SyncEvent) => {} } as EventPublisher)
        const session = cache.getOrCreateSession('copy-legacy', { path: '/tmp', host: 'h' }, null, 'default')
        const base = Date.now() - 600_000

        const copied = store.messages.copyMessageToSession(session.id, {
            content: { role: 'user', content: { type: 'text', text: 'old' }, meta: { sentFrom: 'webapp' } },
            createdAt: base,
            localId: null,
            invokedAt: base,
            scheduledAt: null,
            deliveryState: undefined
        })

        expect(copied.receivedAt).toBe(base)
    })

    it('is a no-op when the source never dismissed anything', () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, { emit: (_e: SyncEvent) => {} } as EventPublisher)
        const duplicate = cache.getOrCreateSession('dup3', { path: '/tmp', host: 'h' }, null, 'default')
        const canonical = cache.getOrCreateSession('canon3', { path: '/tmp', host: 'h' }, null, 'default')
        cache.setSessionBlockedAck(canonical.id, 'ours', Date.now(), 'request:b')

        cache.transferBlockedAck(duplicate.id, canonical.id, 'default')

        expect(store.sessions.getSessionByNamespace(canonical.id, 'default')?.blockedAckKeys)
            .toEqual(['request:b'])
    })
})

describe('merges share one rule for when a reply reached the agent (#1717)', () => {
    it('answers a destination footer with a LOCAL source reply on a slow runner', async () => {
        // The transcript derivation learned to use hub arrival for a reply
        // with no local id; the merge path kept its own copy of the rule and
        // did not. A slow runner then gave that local reply an `invoked_at`
        // earlier than the footer's hub arrival, so the merge moved the
        // answering reply into the destination transcript and left the row
        // blocked anyway.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, { emit: (_e: SyncEvent) => {} } as EventPublisher)
        const source = cache.getOrCreateSession('local-src', { path: '/tmp', host: 'h' }, null, 'default')
        const target = cache.getOrCreateSession('local-dst', { path: '/tmp', host: 'h' }, null, 'default')
        const hubNow = Date.now()
        const RUNNER_BEHIND = 3_600_000

        cache.setSessionLastNotify(target.id, {
            status: 'blocked', at: hubNow - RUNNER_BEHIND, note: 'needs a key',
            receivedAt: hubNow - 60_000
        })
        // Local reply on the source: no localId, so `invoked_at` is the
        // runner's clock and reads an hour before the footer's hub arrival.
        store.messages.addMessage(source.id, {
            role: 'user',
            content: { type: 'text', text: 'here you go' },
            meta: { sentFrom: 'cli' }
        }, undefined, null, hubNow - RUNNER_BEHIND + 1_000, hubNow)

        await cache.mergeSessionHistory(source.id, target.id, 'default')

        expect(cache.getSession(target.id)?.lastNotify ?? null).toBeNull()
    })
})

describe('a maintenance turn does not invalidate the footer (#1717)', () => {
    it('keeps the blocker when thinking starts for maintenance, and clears on the next real turn', () => {
        // A scheduled /compact can reach an IDLE OpenCode session, and the
        // launcher sends thinking=true before compaction starts. The
        // maintenance acknowledgement preserved the footer, and then this
        // keepalive deleted it anyway — so when compaction ended without a new
        // status summary the session stayed out of Blocked with nothing having
        // answered it.
        const { cache } = makeCache()
        const id = seedBlocked(cache, 'maintenance-turn')

        cache.markMaintenanceTurn(id)
        cache.handleSessionAlive({ sid: id, time: Date.now(), thinking: true })
        expect(cache.getSession(id)?.lastNotify?.status).toBe('blocked')

        // The mark is consumed, so a genuine prompt turn still clears.
        cache.handleSessionAlive({ sid: id, time: Date.now(), thinking: false })
        cache.handleSessionAlive({ sid: id, time: Date.now(), thinking: true })
        expect(cache.getSession(id)?.lastNotify ?? null).toBeNull()
    })

    it('never confirms a maintenance turn, even across a second tick of the same turn (cold-review round 23)', () => {
        // The footer surviving in STORAGE (asserted above) is necessary but
        // not sufficient: `thinkingConfirmed` drives whether the WEB hides
        // the chip while `thinking` is true. Confirming it during compaction
        // hid the same still-unanswered footer, and unhiding it when
        // compaction ended made the arrival tracker read it as a brand-new
        // blocker. `maintenanceTurnSessionIds` is a ONE-SHOT mark consumed on
        // the first tick, so a naive fix that only checks it on the rising
        // edge would correctly protect tick one and then confirm tick two —
        // OpenCode can send `thinking: true` more than once while /compact
        // runs.
        const { cache } = makeCache()
        const id = seedBlocked(cache, 'maintenance-turn-confirmed')

        cache.markMaintenanceTurn(id)
        cache.handleSessionAlive({ sid: id, time: Date.now(), thinking: true })
        expect(cache.getSession(id)?.thinkingConfirmed).toBe(false)

        // Second tick, same turn: still thinking, no new mark to consume.
        cache.handleSessionAlive({ sid: id, time: Date.now() + 1, thinking: true })
        expect(cache.getSession(id)?.thinkingConfirmed).toBe(false)

        // Compaction ends; the NEXT genuine turn confirms normally.
        cache.handleSessionAlive({ sid: id, time: Date.now() + 2, thinking: false })
        cache.handleSessionAlive({ sid: id, time: Date.now() + 3, thinking: true })
        expect(cache.getSession(id)?.thinkingConfirmed).toBe(true)
    })

    it('never confirms an IMMEDIATE /compact sent through the ordinary queue path (cold-review round 24)', () => {
        // Sending /compact as an ordinary message (e.g. from HAPI itself,
        // rather than OpenCode scheduling it internally) queues it first —
        // `markMessageQueued` flips `thinking` true and `thinkingConfirmed`
        // false BEFORE the CLI ever acknowledges it is maintenance. By the
        // time `markMaintenanceTurn` arrives, there is no `!wasThinking`
        // rising edge left for the round-23 fix to catch — thinking was
        // already true. The first genuine keepalive that follows would
        // then confirm the turn and hide the footer, exactly the bug round
        // 23 fixed, just reached through a different sequencing.
        const { cache } = makeCache()
        const id = seedBlocked(cache, 'immediate-compact')

        cache.markMessageQueued(id)
        expect(cache.getSession(id)?.thinking).toBe(true)
        expect(cache.getSession(id)?.thinkingConfirmed).toBe(false)

        // The CLI's ack that this queued command is maintenance arrives
        // AFTER thinking already rose.
        cache.markMaintenanceTurn(id)
        expect(cache.getSession(id)?.thinkingConfirmed).toBe(false)

        // The CLI's first genuine keepalive for the compaction itself.
        cache.handleSessionAlive({ sid: id, time: Date.now(), thinking: true })
        expect(cache.getSession(id)?.thinkingConfirmed).toBe(false)
        expect(cache.getSession(id)?.lastNotify?.status).toBe('blocked')

        // Compaction ends; the NEXT genuine turn still confirms normally.
        cache.handleSessionAlive({ sid: id, time: Date.now() + 1, thinking: false })
        cache.handleSessionAlive({ sid: id, time: Date.now() + 2, thinking: true })
        expect(cache.getSession(id)?.thinkingConfirmed).toBe(true)
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

describe('the acknowledgement broadcast stays inside its own schema (#1717)', () => {
    it('publishes the persisted, bounded key set on the (limit+1)th distinct dismissal', () => {
        // The cache keeps dismissal keys after their prompts resolve, so a
        // long-lived session reaches the bound. SQLite trims there; the
        // broadcast did not, so it carried one key over the schema's own
        // limit and the web rejected the whole session — other tabs silently
        // missed the live dismissal.
        const store = new Store(':memory:')
        const emitted: SyncEvent[] = []
        const cache = new SessionCache(store, {
            emit: (event: SyncEvent) => { emitted.push(event) }
        } as EventPublisher)
        const session = cache.getOrCreateSession(
            'ack-bound',
            { path: '/tmp/project', host: 'localhost' },
            null,
            'default'
        )

        for (let i = 0; i < ACK_KEYS_RETENTION_LIMIT + 1; i++) {
            cache.setSessionBlockedAck(session.id, 'handled', Date.now() + i, `request:r${i}`)
        }

        const row = store.sessions.getSessionByNamespace(session.id, 'default')
        const last = emitted
            .filter((event) => event.type === 'session-updated')
            .map((event) => (event as { data: { blockedAck?: { keys?: string[] | null } } }).data)
            .at(-1)

        expect(row?.blockedAckKeys).toHaveLength(ACK_KEYS_RETENTION_LIMIT)
        expect(last?.blockedAck?.keys).toHaveLength(ACK_KEYS_RETENTION_LIMIT)
        // And it is the SAME bounded set the row holds, not merely the same size.
        expect(last?.blockedAck?.keys).toEqual(row?.blockedAckKeys ?? [])
        expect(cache.getSession(session.id)?.blockedAck?.keys).toEqual(row?.blockedAckKeys ?? [])
    })

    it('never evicts a dismissal whose request is still pending, even when the limit\'s worth of later ones arrive (cold-review round 21)', () => {
        // The bound used to keep "the newest N" by position alone. An OLD
        // dismissal whose request stayed open through N later, already-
        // resolved dismissals got evicted on position, and the web then
        // presented that still-open, already-dismissed request as blocked
        // again — a store bug, not a stale cache: the key was genuinely gone.
        const store = new Store(':memory:')
        const emitted: SyncEvent[] = []
        const cache = new SessionCache(store, {
            emit: (event: SyncEvent) => { emitted.push(event) }
        } as EventPublisher)
        const session = cache.getOrCreateSession(
            'ack-bound-live',
            { path: '/tmp/project', host: 'localhost' },
            // Five requests that stay open through every later dismissal below.
            { requests: {
                r0: { tool: 'Bash', arguments: {} },
                r1: { tool: 'Bash', arguments: {} },
                r2: { tool: 'Bash', arguments: {} },
                r3: { tool: 'Bash', arguments: {} },
                r4: { tool: 'Bash', arguments: {} }
            }, completedRequests: {} },
            'default'
        )

        // Dismiss the five still-open requests first (oldest), then enough
        // more — whose requests are NOT in agentState, already resolved by
        // the time they were dismissed — to land one over the bound.
        const total = ACK_KEYS_RETENTION_LIMIT + 1
        for (let i = 0; i < 5; i++) {
            cache.setSessionBlockedAck(session.id, 'handled', Date.now() + i, `request:r${i}`)
        }
        for (let i = 5; i < total; i++) {
            cache.setSessionBlockedAck(session.id, 'handled', Date.now() + i, `request:r${i}`)
        }

        const row = store.sessions.getSessionByNamespace(session.id, 'default')
        const keys = row?.blockedAckKeys ?? []

        expect(keys).toHaveLength(ACK_KEYS_RETENTION_LIMIT)
        // Every still-open request survives regardless of how old its
        // dismissal is.
        for (let i = 0; i < 5; i++) {
            expect(keys).toContain(`request:r${i}`)
        }
        // Budget for resolved keys is (limit - 5), so only the OLDEST
        // resolved dismissal (r5) is evicted to make room — not a live one.
        expect(keys).not.toContain('request:r5')
        for (let i = 6; i < total; i++) {
            expect(keys).toContain(`request:r${i}`)
        }

        const last = emitted
            .filter((event) => event.type === 'session-updated')
            .map((event) => (event as { data: { blockedAck?: { keys?: string[] | null } } }).data)
            .at(-1)
        expect(last?.blockedAck?.keys).toEqual(keys)
    })

    it('keeps a full-session snapshot inside its own schema when 65 live dismissals are all still pending (cold-review round 22)', () => {
        // Round 21 never evicted a LIVE key, but also never capped how many
        // live keys could pile up — with 65 requests simultaneously pending
        // and dismissed, the old 64-key schema bound rejected the whole
        // snapshot even though every key was genuinely live and correctly
        // preserved. The fix raises the schema bound to match the system's
        // own ceiling on pending-request identities, not the retention
        // budget for RESOLVED keys.
        const store = new Store(':memory:')
        const emitted: SyncEvent[] = []
        const cache = new SessionCache(store, {
            emit: (event: SyncEvent) => { emitted.push(event) }
        } as EventPublisher)
        const requests: Record<string, { tool: string; arguments: Record<string, never> }> = {}
        for (let i = 0; i < 65; i++) {
            requests[`r${i}`] = { tool: 'Bash', arguments: {} }
        }
        const session = cache.getOrCreateSession(
            'ack-bound-all-live',
            { path: '/tmp/project', host: 'localhost' },
            { requests, completedRequests: {} },
            'default'
        )

        for (let i = 0; i < 65; i++) {
            cache.setSessionBlockedAck(session.id, 'handled', Date.now() + i, `request:r${i}`)
        }

        const row = store.sessions.getSessionByNamespace(session.id, 'default')
        const keys = row?.blockedAckKeys ?? []

        // All 65 survive — none evicted, because all 65 are live — and the
        // count stays comfortably inside SessionBlockedAckSchema's bound.
        expect(keys).toHaveLength(65)
        for (let i = 0; i < 65; i++) {
            expect(keys).toContain(`request:r${i}`)
        }
        expect(() => SessionBlockedAckSchema.parse({ at: Date.now(), reason: 'handled', keys })).not.toThrow()
    })

    it('keeps a full-session snapshot inside its own schema when the footer shares the live dismissal budget (cold-review round 23)', () => {
        // PENDING_REQUEST_REFS_CAP (200) alone forgot that a dismissal can
        // ALSO cover the current footer, which is a separate live key
        // (`notify:<at>`) from any of the up-to-200 request keys. 200 live
        // request dismissals plus one live footer dismissal is 201 keys,
        // every one of them genuinely live — the fix bounds both the
        // retention limit and the schema at that true ceiling instead.
        const store = new Store(':memory:')
        const emitted: SyncEvent[] = []
        const cache = new SessionCache(store, {
            emit: (event: SyncEvent) => { emitted.push(event) }
        } as EventPublisher)
        const requests: Record<string, { tool: string; arguments: Record<string, never> }> = {}
        for (let i = 0; i < 200; i++) {
            requests[`r${i}`] = { tool: 'Bash', arguments: {} }
        }
        const session = cache.getOrCreateSession(
            'ack-bound-footer-plus-requests',
            { path: '/tmp/project', host: 'localhost' },
            { requests, completedRequests: {} },
            'default'
        )
        const footerAt = Date.now()
        cache.setSessionLastNotify(session.id, { status: 'blocked', at: footerAt, note: 'needs creds' })

        cache.setSessionBlockedAck(session.id, 'handled', footerAt, `notify:${footerAt}`)
        for (let i = 0; i < 200; i++) {
            cache.setSessionBlockedAck(session.id, 'handled', Date.now() + i, `request:r${i}`)
        }

        const row = store.sessions.getSessionByNamespace(session.id, 'default')
        const keys = row?.blockedAckKeys ?? []

        // All 201 survive — the footer key is just as live as any request
        // key, so none is evicted — and the count still validates against
        // SessionBlockedAckSchema.
        expect(keys).toHaveLength(201)
        expect(keys).toContain(`notify:${footerAt}`)
        for (let i = 0; i < 200; i++) {
            expect(keys).toContain(`request:r${i}`)
        }
        expect(() => SessionBlockedAckSchema.parse({ at: Date.now(), reason: 'handled', keys })).not.toThrow()
    })

    it('keeps a full-session snapshot inside its own schema at 202 live dismissals, past the OLD 201 cap (cold-review round 24)', () => {
        // `PENDING_REQUEST_REFS_CAP` (200) is a preview cap on what one
        // summary SURFACES, not a ceiling on how many requests
        // `AgentState.requests` can actually hold at once — it has no
        // enforced max. Sizing round 23's fix at `PENDING_REQUEST_REFS_CAP +
        // 1` (for the footer) treated the preview cap as if it WERE that
        // ceiling, so 202 simultaneously pending-and-dismissed requests —
        // one more than the 201 it allowed — broke the exact same way again.
        // There is no footer in this repro at all; 202 request keys alone
        // are enough.
        const store = new Store(':memory:')
        const emitted: SyncEvent[] = []
        const cache = new SessionCache(store, {
            emit: (event: SyncEvent) => { emitted.push(event) }
        } as EventPublisher)
        const requests: Record<string, { tool: string; arguments: Record<string, never> }> = {}
        for (let i = 0; i < 202; i++) {
            requests[`r${i}`] = { tool: 'Bash', arguments: {} }
        }
        const session = cache.getOrCreateSession(
            'ack-bound-202-live',
            { path: '/tmp/project', host: 'localhost' },
            { requests, completedRequests: {} },
            'default'
        )

        for (let i = 0; i < 202; i++) {
            cache.setSessionBlockedAck(session.id, 'handled', Date.now() + i, `request:r${i}`)
        }

        const row = store.sessions.getSessionByNamespace(session.id, 'default')
        const keys = row?.blockedAckKeys ?? []

        expect(keys).toHaveLength(202)
        for (let i = 0; i < 202; i++) {
            expect(keys).toContain(`request:r${i}`)
        }
        expect(() => SessionBlockedAckSchema.parse({ at: Date.now(), reason: 'handled', keys })).not.toThrow()
    })

    it('never exceeds the cap no matter how far past it live dismissals go (cold-review round 25)', () => {
        // Round 22 picked 65, round 23 picked 201, round 24 picked 2000 —
        // each derived (or re-derived) from one specific repro instead of
        // from the actual invariant. `AgentState.requests` has no enforced
        // limit, so any fixed number eventually meets a real case one key
        // over it — picking a bigger number just relocates the N+1 failure.
        // The fix is structural: once every resolved key is already gone,
        // `serialiseAckKeys` now evicts the oldest LIVE ones too instead of
        // growing past the bound. Proven here at a scale (limit + 500) well
        // beyond anything a "round up" patch would plausibly guess next.
        const store = new Store(':memory:')
        const cache = new SessionCache(store, { emit: (_event: SyncEvent) => {} } as EventPublisher)
        const total = ACK_KEYS_RETENTION_LIMIT + 500
        const session = cache.getOrCreateSession(
            'ack-bound-beyond-any-cap',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        )
        // `SessionCache.setSessionBlockedAck` rebuilds its live-key set from
        // every entry in `agentState.requests` on each call (cold-review
        // round 21), so dismissing this many keys one at a time through it
        // would cost O(total^2) — an unrelated, pre-existing expense this
        // test doesn't need to pay to prove `serialiseAckKeys`'s eviction
        // bound. Building the key sets in plain JS and calling the store
        // directly exercises the exact function this fix changed, at the
        // same scale, in O(total).
        const dismissedKeys: string[] = []
        const livePendingKeys = new Set<string>()
        for (let i = 0; i < total; i++) {
            const key = `request:r${i}`
            dismissedKeys.push(key)
            livePendingKeys.add(key)
        }
        store.sessions.setSessionBlockedAck(
            session.id,
            { at: Date.now(), reason: 'handled', keys: dismissedKeys, livePendingKeys },
            'default'
        )

        const row = store.sessions.getSessionByNamespace(session.id, 'default')
        const keys = row?.blockedAckKeys ?? []

        // The structural guarantee: never more than the limit, regardless of
        // how far past it live dismissals go.
        expect(keys.length).toBeLessThanOrEqual(ACK_KEYS_RETENTION_LIMIT)
        expect(() => SessionBlockedAckSchema.parse({ at: Date.now(), reason: 'handled', keys })).not.toThrow()
        // The newest live dismissals survive; the oldest are what gets
        // evicted once there is nothing resolved left to make room with.
        expect(keys).toContain(`request:r${total - 1}`)
        expect(keys).not.toContain('request:r0')
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

    it('reaches a recently-active session ranked past the per-batch cap (cold-review round 27)', async () => {
        // Candidates are sorted newest-first and the batch cap is 2 here.
        // Two NEWER sessions have nothing to stamp; a third, OLDER session
        // (still inside the 24h window) carries a genuine unanswered
        // footer. A single `.slice(0, maxSessions)` cutoff excludes that
        // third session from the scan entirely — permanently, since this
        // backfill runs once per restart and the same two newer sessions
        // would occupy the cap again next time.
        const { SyncEngine } = await import('./syncEngine')
        const { RpcRegistry } = await import('../socket/rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const now = Date.now()

        // `addMessage` stamps `updatedAt` from the real insert clock, not
        // the message's own (backdated) `createdAt` — pin it explicitly so
        // the candidate sort order ("newest-first") does not depend on
        // which of these three `getOrCreateSession`/`addMessage` calls the
        // test happens to run first in real wall-clock time.
        const sessionTags: Array<[string, number]> = [['newer-a', now + 20_000], ['newer-b', now + 10_000]]
        for (const [tag, pinnedUpdatedAt] of sessionTags) {
            const session = engine.getOrCreateSession(
                `backfill-batch-${tag}`, { path: '/tmp/project', host: 'localhost' }, null, 'default'
            )
            store.messages.addMessage(session.id, {
                role: 'user', content: { type: 'text', text: 'hello' }, meta: { sentFrom: 'webapp' }
            }, `${tag}-msg`, null, now - 1_000)
            engine.recordSessionActivity(session.id, pinnedUpdatedAt)
        }

        const olderBlocked = engine.getOrCreateSession(
            'backfill-batch-older', { path: '/tmp/project', host: 'localhost' }, null, 'default'
        )
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs a key' })
        store.messages.addMessage(olderBlocked.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
            }
        }, undefined, null, now - 60_000, now - 60_000)
        engine.recordSessionActivity(olderBlocked.id, now + 1_000)

        const stamped = engine.backfillRecentNotifySignals({ now, maxSessions: 2 })

        expect(stamped).toBe(1)
        expect(engine.getSession(olderBlocked.id)?.lastNotify?.status).toBe('blocked')
    })
})
