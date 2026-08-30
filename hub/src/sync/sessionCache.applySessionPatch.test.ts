import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

async function waitForAssistantReplyClock(store: Store, sessionId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const session = store.sessions.getSession(sessionId)
        if (session?.assistantReplyClockBackfilled) return session
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    throw new Error('Timed out waiting for assistant reply clock backfill')
}

// Companion guard for syncEngine.handleRealtimeEvent's new "forward structured
// patches without DB refresh" branch (closes the second half of #884). The
// hub-side fast-path is only safe if applySessionPatch keeps the in-memory
// cache consistent with what just landed in the DB — otherwise subsequent
// callers like NotificationHub.getSession would see stale data and the
// cache-vs-DB divergence would manifest as ghost notifications, stale
// pendingRequestsCount, or wrong todos progress in the session list.
describe('SessionCache.applySessionPatch', () => {
    it('records assistant reply time without moving the activity clock', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const created = cache.getOrCreateSession(
            'assistant-reply-patch',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        const activityAt = created.updatedAt

        cache.recordAssistantMessage(created.id, 2_000)

        const after = cache.getSession(created.id)
        expect(after?.lastAssistantMessageAt).toBe(2_000)
        expect(after?.updatedAt).toBe(activityAt)
        expect(events.at(-1)).toMatchObject({
            type: 'session-updated',
            sessionId: created.id,
            data: { lastAssistantMessageAt: 2_000 }
        })
        expect(store.sessions.getSession(created.id)?.lastAssistantMessageAt).toBe(2_000)
        store.close()
    })

    it('backfills the reply clock from legacy transcript rows without blocking refresh', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'legacy-assistant-reply',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'event', data: { type: 'message', message: 'Compacting conversation.' } }
        }, undefined, undefined, 5_000)
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    isSidechain: true,
                    message: { content: [{ type: 'text', text: 'subagent progress' }] }
                }
            }
        }, undefined, undefined, 4_000)
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'historical assistant reply' } }
        }, undefined, undefined, 3_000)

        const db = (store as unknown as { db: import('bun:sqlite').Database }).db
        db.prepare(`
            UPDATE sessions
            SET last_assistant_message_at = NULL,
                assistant_reply_clock_backfilled = 0
            WHERE id = ?
        `).run(session.id)

        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        const loaded = cache.refreshSession(session.id)
        expect(loaded?.lastAssistantMessageAt).toBeNull()
        expect(store.sessions.getSession(session.id)?.assistantReplyClockBackfilled).toBe(false)

        const backfilled = await waitForAssistantReplyClock(store, session.id)
        expect(backfilled.lastAssistantMessageAt).toBe(3_000)
        expect(cache.getSession(session.id)?.lastAssistantMessageAt).toBe(3_000)
        expect(cache.getSession(session.id)?.assistantReplyClockBackfilled).toBe(true)
        expect(events.at(-1)).toMatchObject({
            type: 'session-updated',
            sessionId: session.id,
            data: { lastAssistantMessageAt: 3_000 }
        })
        cache.stop()
        store.close()
    })

    it('backfills a large legacy transcript page by page', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'legacy-large-transcript',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'historical answer' } }
        }, undefined, undefined, 3_000)
        for (let index = 0; index < 450; index += 1) {
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: `historical prompt ${index}` }
            }, undefined, undefined, 4_000 + index)
        }

        const db = (store as unknown as { db: import('bun:sqlite').Database }).db
        db.prepare(`
            UPDATE sessions
            SET last_assistant_message_at = NULL,
                assistant_reply_clock_backfilled = 0
            WHERE id = ?
        `).run(session.id)

        const cache = new SessionCache(store, createPublisher([]))
        expect(cache.refreshSession(session.id)?.lastAssistantMessageAt).toBeNull()

        const backfilled = await waitForAssistantReplyClock(store, session.id)
        expect(backfilled.lastAssistantMessageAt).toBe(3_000)
        expect(backfilled.assistantReplyClockBackfilled).toBe(true)
        cache.stop()
        store.close()
    })

    it('recomputes the reply clock after transcript truncation', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'truncate-reply-clock',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'one' }
        }, 'local-1')
        store.messages.markMessagesInvoked(session.id, ['local-1'], Date.now())
        const firstReply = store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'first answer' } }
        })
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'two' }
        }, 'local-2')
        store.messages.markMessagesInvoked(session.id, ['local-2'], Date.now())
        const secondReply = store.messages.addMessage(session.id, {
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'second answer' } }
        })

        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))
        cache.refreshSession(session.id)
        expect(store.sessions.getSession(session.id)?.lastAssistantMessageAt).toBe(secondReply.createdAt)

        store.messages.truncateMessagesFromLocalId(session.id, 'local-2')
        expect(store.sessions.getSession(session.id)?.assistantReplyClockBackfilled).toBe(false)
        cache.refreshSession(session.id)

        const backfilled = await waitForAssistantReplyClock(store, session.id)
        expect(backfilled.lastAssistantMessageAt).toBe(firstReply.createdAt)
        expect(events.at(-1)).toMatchObject({
            type: 'session-updated',
            sessionId: session.id,
            data: {
                id: session.id,
                lastAssistantMessageAt: firstReply.createdAt
            }
        })
        cache.stop()
        store.close()
    })

    it('marks legacy sessions without replies so they are not rescanned', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'legacy-no-assistant-reply',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        const db = (store as unknown as { db: import('bun:sqlite').Database }).db
        db.prepare(`
            UPDATE sessions
            SET last_assistant_message_at = NULL,
                assistant_reply_clock_backfilled = 0
            WHERE id = ?
        `).run(session.id)

        const firstCache = new SessionCache(store, createPublisher([]))
        expect(firstCache.refreshSession(session.id)?.lastAssistantMessageAt).toBeNull()
        const backfilled = await waitForAssistantReplyClock(store, session.id)
        expect(backfilled.lastAssistantMessageAt).toBeNull()
        expect(backfilled.assistantReplyClockBackfilled).toBe(true)
        expect(firstCache.getSession(session.id)?.assistantReplyClockBackfilled).toBe(true)

        const secondCache = new SessionCache(store, createPublisher([]))
        expect(secondCache.refreshSession(session.id)?.lastAssistantMessageAt).toBeNull()
        expect(store.sessions.getSession(session.id)?.assistantReplyClockBackfilled).toBe(true)
        firstCache.stop()
        secondCache.stop()
        store.close()
    })

    it('does not rewind the reply clock when a stale patch arrives', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'stale-assistant-reply-patch',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        const cache = new SessionCache(store, createPublisher([]))
        cache.recordAssistantMessage(session.id, 2_000)

        expect(cache.applySessionPatch(session.id, { lastAssistantMessageAt: 1_000 })).toBe(true)
        expect(cache.getSession(session.id)?.lastAssistantMessageAt).toBe(2_000)
        expect(store.sessions.getSession(session.id)?.lastAssistantMessageAt).toBe(2_000)
        store.close()
    })

    it('uses the session sequence to gate authoritative reply-clock patches', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'versioned-assistant-reply-patch',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        const cache = new SessionCache(store, createPublisher([]))
        cache.refreshSession(session.id)
        const currentVersion = cache.getSession(session.id)?.seq ?? 0

        expect(cache.applySessionPatch(session.id, {
            lastAssistantMessageAt: 1_000,
            lastAssistantMessageVersion: currentVersion + 1
        })).toBe(true)
        expect(cache.getSession(session.id)).toMatchObject({
            lastAssistantMessageAt: 1_000,
            seq: currentVersion + 1
        })

        expect(cache.applySessionPatch(session.id, {
            lastAssistantMessageAt: null,
            lastAssistantMessageVersion: currentVersion
        })).toBe(true)
        expect(cache.getSession(session.id)?.lastAssistantMessageAt).toBe(1_000)

        expect(cache.applySessionPatch(session.id, {
            lastAssistantMessageAt: null,
            lastAssistantMessageVersion: currentVersion + 2
        })).toBe(true)
        expect(cache.getSession(session.id)?.lastAssistantMessageAt).toBeNull()
        store.close()
    })

    it('applies a todos patch in place when the session is cached', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'todos-patch-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )

        const todos = [
            { content: 'one', status: 'pending' as const, priority: 'medium' as const, id: '1' }
        ]
        const applied = cache.applySessionPatch(created.id, {
            todos: { version: 100, value: todos }
        })

        expect(applied).toBe(true)
        expect(cache.getSession(created.id)?.todos).toEqual(todos)
        expect(cache.getSession(created.id)?.todosUpdatedAt).toBe(100)
    })

    it('applies a versioned metadata patch by unwrapping value + version', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'meta-patch-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )

        const nextVersion = created.metadataVersion + 1
        const applied = cache.applySessionPatch(created.id, {
            metadata: {
                version: nextVersion,
                value: { path: '/tmp', host: 'h', lifecycleState: 'archived' }
            }
        })

        expect(applied).toBe(true)
        const after = cache.getSession(created.id)
        expect(after?.metadata?.lifecycleState).toBe('archived')
        expect(after?.metadataVersion).toBe(nextVersion)
    })

    it('applies a versioned agentState patch with null value', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'agent-patch-session',
            { path: '/tmp', host: 'h' },
            { controlledByUser: true },
            'default'
        )
        expect(created.agentState).not.toBeNull()

        const nextVersion = created.agentStateVersion + 1
        const applied = cache.applySessionPatch(created.id, {
            agentState: { version: nextVersion, value: null }
        })

        expect(applied).toBe(true)
        const after = cache.getSession(created.id)
        expect(after?.agentState).toBeNull()
        expect(after?.agentStateVersion).toBe(nextVersion)
    })

    it('returns false (caller falls back to refresh) when the session is not cached', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const applied = cache.applySessionPatch('does-not-exist', { todos: { version: 1, value: [] } })
        expect(applied).toBe(false)
    })

    it('returns false when patch data fails SessionPatchSchema', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'bad-patch-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )

        // Bogus shape: { metadata: { value: ... } } is missing the required version.
        const applied = cache.applySessionPatch(created.id, {
            metadata: { value: { path: '/x', host: 'y' } }
        })
        expect(applied).toBe(false)
    })

    it('refuses an empty patch ({}) so the caller falls back to refreshSession', () => {
        // Web-side getSessionPatch rejects empty payloads (Object.keys length 0)
        // and would fall through to REST invalidation — exactly the storm we
        // are closing. The empty-patch guard keeps the syncEngine on the safe
        // legacy refresh path for these no-op events.
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'empty-patch-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )

        expect(cache.applySessionPatch(created.id, {})).toBe(false)
    })

    it('clears cached teamState when a null teamState patch lands (TeamDelete)', () => {
        // PR #897 review (HAPI Bot, 2026-06-13 Major): TeamDelete events
        // drive applyTeamStateDelta to return null; the emit-site sends
        // { teamState: null } as the explicit clear signal. Without
        // hasOwnProperty-discrimination, `if (patch.teamState !== undefined)`
        // skipped the clear path and left the hub cache holding stale
        // pre-delete TeamState — sidebar / NotificationHub / dedup all
        // would serve stale data until the next full refresh.
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'teamstate-clear-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        // Seed cached teamState (the pre-delete state).
        const seedApplied = cache.applySessionPatch(created.id, {
            teamState: { version: 10, value: { teamName: 'crew', members: [{ name: 'a' }] } }
        })
        expect(seedApplied).toBe(true)
        expect(cache.getSession(created.id)?.teamState?.teamName).toBe('crew')

        // TeamDelete: null teamState value must clear the cache.
        const cleared = cache.applySessionPatch(created.id, { teamState: { version: 11, value: null } })
        expect(cleared).toBe(true)
        expect(cache.getSession(created.id)?.teamState).toBeUndefined()
    })

    it('leaves teamState untouched when the patch does not carry the key', () => {
        // Guard the hasOwnProperty discriminator against a refactor back to
        // `if (patch.teamState !== undefined)` — a todos-only patch must
        // NOT clear teamState, which a naive `?? undefined` assignment on
        // the unconditional branch would do.
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'teamstate-untouched-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        cache.applySessionPatch(created.id, {
            teamState: { version: 10, value: { teamName: 'crew', members: [{ name: 'a' }] } }
        })
        expect(cache.getSession(created.id)?.teamState?.teamName).toBe('crew')

        const todosOnly = cache.applySessionPatch(created.id, {
            todos: {
                version: 20,
                value: [{ content: 'one', status: 'pending' as const, priority: 'medium' as const, id: '1' }]
            }
        })
        expect(todosOnly).toBe(true)
        expect(cache.getSession(created.id)?.teamState?.teamName).toBe('crew')
    })

    it('refuses cross-namespace patches even if the session exists', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'ns-guard-session',
            { path: '/tmp', host: 'h' },
            null,
            'tenant-a'
        )

        const applied = cache.applySessionPatch(created.id, { todos: { version: 1, value: [] } }, 'tenant-b')
        expect(applied).toBe(false)
    })
})
