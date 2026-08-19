import { describe, expect, it } from 'bun:test'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { getReasoningStreamId } from '@hapi/protocol/messages'
import { Store } from './index'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string) {
    return store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

describe('cancelQueuedMessage', () => {
    it('happy path: deletes queued message, returns status=cancelled with localId', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-happy')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-1')

        const result = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe('lid-1')
        }

        // Row should be gone from uninvoked list
        const remaining = store.messages.getUninvokedLocalMessages(session.id)
        expect(remaining).toHaveLength(0)
        expect(store.messages.getMessageEpoch(session.id)).toBe(1)
    })

    it('already-invoked: returns status=invoked with full message row, row stays in DB', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-already-invoked')
        const content = { role: 'user', content: { type: 'text', text: 'hello' } }
        const msg = store.messages.addMessage(session.id, content, 'lid-2')

        const invokedAt = Date.now()
        // Simulate CLI invoke ack
        store.messages.markMessagesInvoked(session.id, ['lid-2'], invokedAt)

        const result = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('invoked')

        // Must include the invoked row so the web client can restore authoritative state
        if (result.status === 'invoked') {
            expect(result.message.id).toBe(msg.id)
            expect(result.message.localId).toBe('lid-2')
            expect(result.message.invokedAt).toBe(invokedAt)
        }

        // Row still exists (with invoked_at set)
        const messages = store.messages.getMessages(session.id)
        expect(messages.some(m => m.id === msg.id)).toBe(true)
    })

    it('cancel × 2 idempotent: second call returns status=cancelled with localId=null (row gone)', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-idempotent')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-3')

        const first = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(first.status).toBe('cancelled')
        if (first.status === 'cancelled') {
            expect(first.localId).toBe('lid-3')
        }

        const second = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(second.status).toBe('cancelled')
        if (second.status === 'cancelled') {
            expect(second.localId).toBeNull()
        }
        expect(store.messages.getMessageEpoch(session.id)).toBe(1)
    })

    it('non-existent messageId: returns status=cancelled with localId=null', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-nonexistent')

        const result = store.messages.cancelQueuedMessage(session.id, 'nonexistent-id')
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBeNull()
        }
    })

    it('wrong sessionId: returns status=cancelled with localId=null, message from other session untouched', () => {
        const store = makeStore()
        const sessionA = makeSession(store, 'cancel-session-a')
        const sessionB = makeSession(store, 'cancel-session-b')
        const msg = store.messages.addMessage(sessionA.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-A')

        const result = store.messages.cancelQueuedMessage(sessionB.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBeNull()
        }

        // Original message still exists
        const remaining = store.messages.getUninvokedLocalMessages(sessionA.id)
        expect(remaining).toHaveLength(1)
    })

    it('cancelled localId is propagated from the deleted row', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-localid-propagate')
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-propagate')

        const result = store.messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe('lid-propagate')
        }
    })

    it('cancel by localId before server echo: localId match returns status=cancelled with localId', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-by-localid')
        // Simulate the optimistic row: server has stored it with local_id but web client
        // still holds msg.id === localId (server echo not yet received).
        const localId = 'local:pre-echo-id'
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, localId)

        // The web client passes localId as messageId (before server echo replaces it)
        const result = store.messages.cancelQueuedMessage(session.id, localId)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe(localId)
        }

        // Row should be gone
        const remaining = store.messages.getUninvokedLocalMessages(session.id)
        expect(remaining).toHaveLength(0)
    })

    it('cancel by localId × 2 idempotent: second call returns status=cancelled with localId=null', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-by-localid-idempotent')
        const localId = 'local:idem-id'
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, localId)

        const first = store.messages.cancelQueuedMessage(session.id, localId)
        expect(first.status).toBe('cancelled')
        if (first.status === 'cancelled') {
            expect(first.localId).toBe(localId)
        }

        // Second cancel by the same localId — row is already gone
        const second = store.messages.cancelQueuedMessage(session.id, localId)
        expect(second.status).toBe('cancelled')
        if (second.status === 'cancelled') {
            expect(second.localId).toBeNull()
        }
    })

    it('cancel by localId when invoked: returns status=invoked with message row', () => {
        const store = makeStore()
        const session = makeSession(store, 'cancel-by-localid-invoked')
        const localId = 'local:invoked-id'
        const msg = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, localId)

        const invokedAt = Date.now()
        store.messages.markMessagesInvoked(session.id, [localId], invokedAt)

        // Web client passes localId as messageId — should detect invoked_at IS NOT NULL
        const result = store.messages.cancelQueuedMessage(session.id, localId)
        expect(result.status).toBe('invoked')
        if (result.status === 'invoked') {
            expect(result.message.id).toBe(msg.id)
            expect(result.message.localId).toBe(localId)
            expect(result.message.invokedAt).toBe(invokedAt)
        }

        // Row still exists
        const messages = store.messages.getMessages(session.id)
        expect(messages.some(m => m.id === msg.id)).toBe(true)
    })
})

describe('recordMessagesConsumed', () => {
    it('rolls back the invocation transition when the session namespace cannot be verified', () => {
        const store = makeStore()
        const session = makeSession(store, 'consumed-rollback-wrong-namespace')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'local-rollback')
        const originalUpdatedAt = store.sessions.getSession(session.id)?.updatedAt

        expect(() => store.recordMessagesConsumed(session.id, ['local-rollback'], 2_000, 'other-namespace'))
            .toThrow('session not found after messages-consumed transition')
        expect(store.messages.getLocalMessageStates(session.id, ['local-rollback']))
            .toEqual([{ localId: 'local-rollback', invokedAt: null }])
        expect(store.sessions.getSession(session.id)?.updatedAt).toBe(originalUpdatedAt)
    })
})

describe('position pagination and structural epochs', () => {
    it('returns rows strictly after a cursor and respects an inclusive snapshot head', () => {
        const store = makeStore()
        const session = makeSession(store, 'position-after')
        const first = store.messages.addMessage(session.id, { text: 'first' })
        const second = store.messages.addMessage(session.id, { text: 'second' })
        const third = store.messages.addMessage(session.id, { text: 'third' })
        store.messages.addMessage(session.id, { text: 'fourth' })

        const rows = store.messages.getMessagesAfterPosition(
            session.id,
            10,
            { at: first.invokedAt ?? first.createdAt, seq: first.seq },
            { at: third.invokedAt ?? third.createdAt, seq: third.seq }
        )

        expect(rows.map((message) => message.id)).toEqual([second.id, third.id])
    })

    it('reports the newest composite position', () => {
        const store = makeStore()
        const session = makeSession(store, 'position-head')
        const first = store.messages.addMessage(session.id, { text: 'first' })
        const second = store.messages.addMessage(session.id, { text: 'second' })

        expect(store.messages.getNewestMessagePosition(session.id)).toEqual({
            at: second.invokedAt ?? second.createdAt,
            seq: second.seq
        })
        expect(first.seq).toBeLessThan(second.seq)
    })

    it('bumps both epochs when session history is merged', () => {
        const store = makeStore()
        const source = makeSession(store, 'epoch-merge-source')
        const target = makeSession(store, 'epoch-merge-target')
        store.messages.addMessage(source.id, { text: 'source' })
        store.messages.addMessage(target.id, { text: 'target' })

        const result = store.messages.mergeSessionMessages(source.id, target.id)

        expect(result.moved).toBe(1)
        expect(store.messages.getMessageEpoch(source.id)).toBe(1)
        expect(store.messages.getMessageEpoch(target.id)).toBe(1)
    })

    it('clamps future client timestamps to hub receive time', () => {
        const store = makeStore()
        const session = makeSession(store, 'future-client-clock')
        const before = Date.now()

        const message = store.messages.addMessage(
            session.id,
            { text: 'future clock' },
            undefined,
            undefined,
            before + 60_000,
        )

        expect(message.createdAt).toBeGreaterThanOrEqual(before)
        expect(message.createdAt).toBeLessThanOrEqual(Date.now())
        expect(message.invokedAt).toBe(message.createdAt)
    })

    it('bumps the epoch when a newly inserted message is backdated behind the cached head', () => {
        const store = makeStore()
        const session = makeSession(store, 'epoch-backdated-insert')
        const head = store.messages.addMessage(session.id, { text: 'head' })
        const headPosition = { at: head.invokedAt ?? head.createdAt, seq: head.seq }

        const backdated = store.messages.addMessage(
            session.id,
            { text: 'backdated' },
            undefined,
            undefined,
            headPosition.at - 1_000,
        )

        expect(backdated.seq).toBeGreaterThan(head.seq)
        expect(store.messages.getMessagesAfterPosition(session.id, 10, headPosition)).toEqual([])
        expect(store.messages.getMessageEpoch(session.id)).toBe(1)
    })

    it('bumps the target epoch when a copied message lands behind the cached head', () => {
        const store = makeStore()
        const target = makeSession(store, 'epoch-copy-target')
        const head = store.messages.addMessage(target.id, { text: 'head' })
        const headPosition = {
            at: head.invokedAt ?? head.createdAt,
            seq: head.seq
        }

        const copied = store.messages.copyMessageToSession(target.id, {
            content: { text: 'historical' },
            createdAt: headPosition.at - 1_000,
            localId: null,
            invokedAt: headPosition.at - 1_000,
            scheduledAt: null
        })

        expect(copied.seq).toBeGreaterThan(head.seq)
        expect(store.messages.getMessagesAfterPosition(target.id, 10, headPosition)).toEqual([])
        expect(store.messages.getMessageEpoch(target.id)).toBe(1)
    })
})

describe('addMessage: scheduledAt invariants', () => {
    it('rejects scheduledAt without a localId — would silently invoke immediately', () => {
        const store = makeStore()
        const session = makeSession(store, 'sched-invariant')
        const future = Date.now() + 60_000

        expect(() =>
            store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'orphan scheduled' } },
                undefined,
                future
            )
        ).toThrow(/scheduledAt requires a localId/)
    })

    it('accepts scheduledAt when paired with a localId and keeps invoked_at NULL', () => {
        const store = makeStore()
        const session = makeSession(store, 'sched-ok')
        const future = Date.now() + 60_000

        const msg = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'queued for later' } },
            'lid-sched',
            future
        )

        expect(msg.scheduledAt).toBe(future)
        expect(msg.invokedAt).toBeNull()
    })
})

describe('getDeliverableMessagesAfter: CLI backfill excludes future-scheduled rows', () => {
    it('omits rows whose scheduled_at > now (would otherwise be replayed early on reconnect)', () => {
        const store = makeStore()
        const session = makeSession(store, 'backfill-future-sched')
        const now = Date.now()
        const future = now + 60_000
        const past = now - 60_000

        const immediate = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'immediate' } },
            'lid-immediate'
        )
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'future-scheduled' } },
            'lid-future',
            future
        )
        const matureSched = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'mature-scheduled' } },
            'lid-mature',
            past
        )

        const delivered = store.messages.getDeliverableMessagesAfter(session.id, 0, now)
        const ids = delivered.map((m) => m.id)
        expect(ids).toContain(immediate.id)
        expect(ids).toContain(matureSched.id)
        expect(ids).not.toContain('lid-future')
        const localIds = delivered.map((m) => m.localId)
        expect(localIds).not.toContain('lid-future')
    })

    it('returns the row once now advances past scheduled_at (release boundary)', () => {
        const store = makeStore()
        const session = makeSession(store, 'backfill-release-boundary')
        const fireAt = Date.now() - 60_000

        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'boundary' } },
            'lid-bnd',
            fireAt
        )

        const before = store.messages.getDeliverableMessagesAfter(session.id, 0, fireAt - 1)
        expect(before.find((m) => m.localId === 'lid-bnd')).toBeUndefined()

        const exact = store.messages.getDeliverableMessagesAfter(session.id, 0, fireAt)
        expect(exact.find((m) => m.localId === 'lid-bnd')).toBeDefined()
    })

    it('respects afterSeq alongside the scheduled_at filter (2-axis interaction)', () => {
        // Verifies the seq cursor and the scheduled-at filter compose correctly:
        // a row that satisfies one axis but fails the other must be excluded.
        const store = makeStore()
        const session = makeSession(store, 'backfill-2axis')
        const now = Date.now()

        const m1 = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'first' } },
            'lid-1'
        )
        const m2 = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'second' } },
            'lid-2'
        )

        // afterSeq = m1.seq → only m2 should be returned.
        const onlyM2 = store.messages.getDeliverableMessagesAfter(session.id, m1.seq, now)
        expect(onlyM2.map((m) => m.id)).toEqual([m2.id])

        // afterSeq = m2.seq → nothing (cursor at the end).
        const empty = store.messages.getDeliverableMessagesAfter(session.id, m2.seq, now)
        expect(empty).toHaveLength(0)
    })
})

describe('countFutureScheduledLocalMessages', () => {
    it('counts only future scheduled uninvoked local messages', () => {
        const store = makeStore()
        const session = makeSession(store, 'sched-count')
        const now = Date.now()

        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'immediate queued' } },
            'local-immediate'
        )
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'future scheduled' } },
            'local-future',
            now + 60_000
        )
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'mature scheduled' } },
            'local-mature',
            now - 1
        )

        expect(store.messages.countFutureScheduledLocalMessages(session.id, now)).toBe(1)
    })

    it('batch query returns counts keyed by session id', () => {
        const store = makeStore()
        const sessionA = makeSession(store, 'sched-batch-a')
        const sessionB = makeSession(store, 'sched-batch-b')
        const now = Date.now()

        store.messages.addMessage(
            sessionA.id,
            { role: 'user', content: { type: 'text', text: 'a1' } },
            'a-1',
            now + 60_000
        )
        store.messages.addMessage(
            sessionA.id,
            { role: 'user', content: { type: 'text', text: 'a2' } },
            'a-2',
            now + 120_000
        )
        store.messages.addMessage(
            sessionB.id,
            { role: 'user', content: { type: 'text', text: 'immediate' } },
            'b-1'
        )

        const counts = store.messages.countFutureScheduledBySessionIds([sessionA.id, sessionB.id], now)
        expect(counts.get(sessionA.id)).toBe(2)
        expect(counts.get(sessionB.id)).toBeUndefined()

        const nextAt = store.messages.minFutureScheduledAtBySessionIds([sessionA.id, sessionB.id], now)
        expect(nextAt.get(sessionA.id)).toBe(now + 60_000)
        expect(nextAt.get(sessionB.id)).toBeUndefined()
    })
})

describe('moveUninvokedScheduledMessages', () => {
    it('atomically moves only pending scheduled rows to the replacement session', () => {
        const store = makeStore()
        const source = makeSession(store, 'scheduled-source')
        const replacement = makeSession(store, 'scheduled-replacement')
        const now = Date.now()
        const scheduled = store.messages.addMessage(source.id, { text: 'later' }, 'scheduled-local', now + 60_000)
        store.messages.addMessage(source.id, { text: 'ordinary queued' }, 'ordinary-local')

        expect(store.messages.moveUninvokedScheduledMessages(source.id, replacement.id)).toBe(1)
        expect(store.messages.getAllMessages(source.id).map((message) => message.id)).not.toContain(scheduled.id)
        expect(store.messages.getAllMessages(replacement.id)).toEqual([
            expect.objectContaining({ id: scheduled.id, localId: 'scheduled-local', scheduledAt: now + 60_000, invokedAt: null })
        ])
        expect(store.messages.getUninvokedLocalMessages(source.id)).toEqual([
            expect.objectContaining({ localId: 'ordinary-local', scheduledAt: null })
        ])
    })
})

describe('markUninvokedImmediateMessages', () => {
    it('settles immediate queued rows while preserving scheduled rows for clear transfer', () => {
        const store = makeStore()
        const source = makeSession(store, 'clear-source-immediate')
        const invokedAt = Date.now()
        store.messages.addMessage(source.id, { text: 'immediate' }, 'immediate-local')
        store.messages.addMessage(source.id, { text: 'scheduled' }, 'scheduled-local', invokedAt + 60_000)

        expect(store.messages.markUninvokedImmediateMessages(source.id, invokedAt)).toEqual(['immediate-local'])
        expect(store.messages.getAllMessages(source.id)).toEqual(expect.arrayContaining([
            expect.objectContaining({ localId: 'immediate-local', invokedAt }),
            expect.objectContaining({ localId: 'scheduled-local', invokedAt: null })
        ]))
    })
})

describe('content codec integration', () => {
    it('stores large agent content compressed and returns it truncated on read', () => {
        const store = makeStore()
        const session = makeSession(store, 'codec-agent')
        const stdout = 'line\n'.repeat(60_000) // ~300KB, above the truncate limit
        const content = {
            role: 'agent',
            content: { type: 'codex', data: { type: 'tool-call-result', callId: 'c1', output: { stdout } } }
        }

        const added = store.messages.addMessage(session.id, content)
        const read = store.messages.getMessages(session.id, 10)
        expect(read).toHaveLength(1)

        const readContent = read[0]!.content as typeof content
        expect(readContent.content.data.output.stdout.length).toBeLessThan(stdout.length)
        expect(readContent.content.data.output.stdout).toContain('[hapi: truncated')
        expect(readContent.content.data.callId).toBe('c1')
        // addMessage's return value matches what a later read sees (SSE broadcast uses it)
        expect(added.content).toEqual(read[0]!.content)
    })

    it('round-trips large queued user prompts verbatim (delivery path must not truncate)', () => {
        const store = makeStore()
        const session = makeSession(store, 'codec-user')
        const text = 'prompt '.repeat(30_000) // ~210KB user paste
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text } },
            'lid-big',
            Date.now() + 60_000
        )

        const scheduled = store.messages.getMatureScheduledMessages(Date.now() + 120_000)
        expect(scheduled).toHaveLength(1)
        const delivered = scheduled[0]!.content as { content: { text: string } }
        expect(delivered.content.text).toBe(text)
    })

    it('requeues an indeterminate delivery only on explicit request', () => {
        const store = makeStore()
        const session = makeSession(store, 'requeue-indeterminate')
        const msg = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'retry me' } },
            'lid-retry'
        )
        expect(store.messages.setMessagesDeliveryState(session.id, ['lid-retry'], 'dispatching')).toBe(1)
        expect(store.messages.setMessagesDeliveryState(session.id, ['lid-retry'], 'indeterminate')).toBe(1)
        expect(store.messages.getDeliverableMessagesAfter(session.id, 0, Date.now())).toHaveLength(0)
        const claimed = store.messages.claimIndeterminateMessage(session.id, msg.id)
        expect(claimed).toMatchObject({ id: msg.id, invokedAt: null, deliveryState: 'indeterminate' })
        expect(store.messages.claimIndeterminateMessage(session.id, msg.id)).toBeNull()
        expect(store.messages.getDeliverableMessagesAfter(session.id, 0, Date.now())).toHaveLength(0)
        expect(store.messages.setMessagesDeliveryState(session.id, ['lid-retry'], 'queued')).toBe(1)
        expect(store.messages.getDeliverableMessagesAfter(session.id, 0, Date.now())).toHaveLength(1)
    })

    it('holds indeterminate delivery out of replay without stamping invoked_at', () => {
        const store = makeStore()
        const session = makeSession(store, 'indeterminate')
        const msg = store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'uncertain' } },
            'lid-uncertain'
        )

        expect(store.messages.markMessagesIndeterminate(session.id, ['lid-uncertain'])).toBe(1)
        expect(store.messages.markMessagesIndeterminate(session.id, ['lid-uncertain'])).toBe(0)
        expect(store.messages.getDeliverableMessagesAfter(session.id, 0, Date.now())).toHaveLength(0)
        expect(store.messages.getImmediateQueuedLocalMessages(session.id)).toHaveLength(0)
        expect(store.messages.getUninvokedLocalMessages(session.id)[0]).toMatchObject({
            id: msg.id,
            deliveryState: 'indeterminate',
            invokedAt: null
        })
        expect(store.messages.lookupQueuedMessage(session.id, msg.id)).toEqual({
            status: 'indeterminate',
            localId: 'lid-uncertain',
            resolvedId: msg.id,
            scheduledAt: null
        })

        const invokedAt = Date.now()
        expect(store.messages.markMessagesInvoked(session.id, ['lid-uncertain'], invokedAt)).toBe(1)
        expect(store.messages.getMessages(session.id)[0]).toMatchObject({ invokedAt })
    })
})

describe('deleteLiveReasoningSnapshots', () => {
    function reasoningMessage(streamId: string, text: string, live: boolean) {
        return {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'reasoning', message: text, id: streamId, ...(live ? { live: true } : {}) }
            }
        }
    }

    function reasoningTexts(store: Store, sessionId: string): string[] {
        return store.messages.getAllMessages(sessionId)
            .map((message) => getReasoningStreamId(message.content) === null
                ? null
                : ((message.content as { content: { data: { message: string } } }).content.data.message))
            .filter((text): text is string => text !== null)
    }

    it('keeps only the newest snapshot of a stream', () => {
        const store = makeStore()
        const session = makeSession(store, 'reasoning-collapse')

        for (const text of ['a', 'ab', 'abc']) {
            const stored = store.messages.addMessage(session.id, reasoningMessage('stream-1', text, true))
            store.messages.deleteLiveReasoningSnapshots(session.id, 'stream-1', stored.id)
        }

        expect(reasoningTexts(store, session.id)).toEqual(['abc'])
    })

    it('lets a settled message supersede the snapshots of its own stream', () => {
        const store = makeStore()
        const session = makeSession(store, 'reasoning-settle')

        store.messages.addMessage(session.id, reasoningMessage('stream-1', 'partial', true))
        const settled = store.messages.addMessage(session.id, reasoningMessage('stream-1', 'final', false))
        store.messages.deleteLiveReasoningSnapshots(session.id, 'stream-1', settled.id)

        expect(reasoningTexts(store, session.id)).toEqual(['final'])
    })

    it('never removes a settled message', () => {
        const store = makeStore()
        const session = makeSession(store, 'reasoning-settled-kept')

        store.messages.addMessage(session.id, reasoningMessage('stream-1', 'final', false))
        const removed = store.messages.deleteLiveReasoningSnapshots(session.id, 'stream-1')

        expect(removed).toBe(0)
        expect(reasoningTexts(store, session.id)).toEqual(['final'])
    })

    it('leaves other streams alone', () => {
        const store = makeStore()
        const session = makeSession(store, 'reasoning-other-stream')

        store.messages.addMessage(session.id, reasoningMessage('stream-1', 'first', true))
        const other = store.messages.addMessage(session.id, reasoningMessage('stream-2', 'second', true))
        store.messages.deleteLiveReasoningSnapshots(session.id, 'stream-2', other.id)

        expect(reasoningTexts(store, session.id)).toEqual(['first', 'second'])
    })

    it('never crosses a session boundary', () => {
        const store = makeStore()
        const mine = makeSession(store, 'reasoning-mine')
        const theirs = makeSession(store, 'reasoning-theirs')

        store.messages.addMessage(theirs.id, reasoningMessage('stream-1', 'theirs', true))
        store.messages.deleteLiveReasoningSnapshots(mine.id, 'stream-1')

        expect(reasoningTexts(store, theirs.id)).toEqual(['theirs'])
    })

    it('spares the message that replaced the snapshots', () => {
        const store = makeStore()
        const session = makeSession(store, 'reasoning-keep-replacement')

        const replacement = store.messages.addMessage(session.id, reasoningMessage('stream-1', 'newest', true))
        const removed = store.messages.deleteLiveReasoningSnapshots(session.id, 'stream-1', replacement.id)

        expect(removed).toBe(0)
        expect(reasoningTexts(store, session.id)).toEqual(['newest'])
    })

    it('never lets a stream pass through zero rows', () => {
        const store = makeStore()
        const session = makeSession(store, 'reasoning-never-empty')

        // Walk a stream the way the handler does — store, then sweep — and
        // assert the stream is represented after every single step.
        for (const text of ['a', 'ab', 'abc', 'abcd']) {
            const stored = store.messages.addMessage(session.id, reasoningMessage('stream-1', text, true))
            expect(reasoningTexts(store, session.id).length).toBeGreaterThan(0)
            store.messages.deleteLiveReasoningSnapshots(session.id, 'stream-1', stored.id)
            expect(reasoningTexts(store, session.id)).toEqual([text])
        }
    })

    it('leaves unrelated messages untouched', () => {
        const store = makeStore()
        const session = makeSession(store, 'reasoning-unrelated')

        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } })
        store.messages.addMessage(session.id, reasoningMessage('stream-1', 'partial', true))
        store.messages.deleteLiveReasoningSnapshots(session.id, 'stream-1')

        expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
        expect(reasoningTexts(store, session.id)).toEqual([])
    })
})
