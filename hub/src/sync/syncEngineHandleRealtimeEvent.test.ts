import { describe, expect, it } from 'bun:test'
import { WORK_GRAPH_MAX_SUMMARY } from '@hapi/protocol'
import type { SessionPatch, SyncEvent } from '@hapi/protocol/types'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

/**
 * Regression guard for the in-place-mutation interaction between
 * `SessionCache.applySessionPatch` and `SyncEngine.handleRealtimeEvent`'s
 * dedup trigger.
 *
 * `applySessionPatch` MUTATES the cached Session in place (it reassigns
 * `session.metadata = patch.metadata.value`). The dedup-on-metadata-change
 * branch in `handleRealtimeEvent` needs to compare BEFORE and AFTER agent
 * session IDs to decide whether to trigger `deduplicateByAgentSessionId`.
 * Without snapshotting the metadata reference before the mutation, `before`
 * and `after` resolve to the SAME object reference, `hasSameAgentSessionIds`
 * is always true, and dedup silently never fires on the fast path. The
 * legacy `refreshSession` path got dedup for free because it REPLACED the
 * cache entry with a new Session object, leaving the pre-refresh reference
 * intact for the comparator.
 *
 * This was a real regression introduced by the refetch-storm fix
 * (#884 second half) — the fast-path replaced the refresh-then-broadcast
 * path for the four CLI emit-sites including the `update-metadata` RPC
 * handler, which is exactly where a Cursor session id change would land
 * (CLI resume re-stamps `metadata.cursorSessionId`).
 */
describe('SyncEngine.handleRealtimeEvent dedup-on-metadata-change', () => {
    function makeEngine(): { engine: SyncEngine; cache: SessionCache; dedupCalls: string[] } {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        const cache = (engine as unknown as { sessionCache: SessionCache }).sessionCache
        const dedupCalls: string[] = []
        const originalDedup = cache.deduplicateByAgentSessionId.bind(cache)
        cache.deduplicateByAgentSessionId = async (sessionId: string) => {
            dedupCalls.push(sessionId)
            // Do not actually run dedup; we only need to assert the trigger
            // fired. Running the real merge logic would require additional
            // store fixtures and is covered by sessionCache tests.
            void originalDedup
        }
        return { engine, cache, dedupCalls }
    }

    it('triggers dedup when a structured metadata patch changes the agent session id', () => {
        const { engine, cache, dedupCalls } = makeEngine()

        const created = cache.getOrCreateSession(
            'cursor-session-fast-path',
            { path: '/tmp', host: 'h', flavor: 'cursor', cursorSessionId: 'cursor-old' },
            null,
            'default'
        )

        const patch: SessionPatch = {
            metadata: {
                version: created.metadataVersion + 1,
                value: {
                    path: '/tmp',
                    host: 'h',
                    flavor: 'cursor',
                    cursorSessionId: 'cursor-new'
                }
            }
        }

        const event: SyncEvent = {
            type: 'session-updated',
            sessionId: created.id,
            data: patch
        }
        engine.handleRealtimeEvent(event)

        expect(dedupCalls).toEqual([created.id])
        expect(cache.getSession(created.id)?.metadata?.cursorSessionId).toBe('cursor-new')
    })

    it('does not trigger dedup when the patch leaves agent session ids unchanged', () => {
        const { engine, cache, dedupCalls } = makeEngine()

        const created = cache.getOrCreateSession(
            'cursor-session-fast-path-noop',
            { path: '/tmp', host: 'h', flavor: 'cursor', cursorSessionId: 'cursor-stable' },
            null,
            'default'
        )

        // A todos patch carries no metadata and must NOT trigger dedup.
        const event: SyncEvent = {
            type: 'session-updated',
            sessionId: created.id,
            data: { todos: { version: 1, value: [] } } satisfies SessionPatch
        }
        engine.handleRealtimeEvent(event)

        expect(dedupCalls).toEqual([])
    })

    it('triggers dedup on the legacy refresh fallback path (no patch data)', () => {
        // Tighten the contract for the legacy refresh-from-DB branch:
        // a no-`data` session-updated event still needs to fire dedup
        // when the DB read surfaces a new agent session id. The shared
        // `beforeMetadata` snapshot covers both branches, this guards
        // against a refactor breaking the legacy path.
        const { engine, cache, dedupCalls } = makeEngine()

        const created = cache.getOrCreateSession(
            'cursor-session-legacy-path',
            { path: '/tmp', host: 'h', flavor: 'cursor', cursorSessionId: 'cursor-legacy-old' },
            null,
            'default'
        )

        // Persist a metadata change to the DB without going through the
        // cache mutation path, so refreshSession's DB read picks up the
        // new value when handleRealtimeEvent fires.
        const updateResult = (engine as unknown as { store: Store }).store.sessions.updateSessionMetadata(
            created.id,
            { path: '/tmp', host: 'h', flavor: 'cursor', cursorSessionId: 'cursor-legacy-new' },
            created.metadataVersion,
            'default',
            { touchUpdatedAt: false }
        )
        expect(updateResult.result).toBe('success')

        const event: SyncEvent = {
            type: 'session-updated',
            sessionId: created.id
        }
        engine.handleRealtimeEvent(event)

        expect(dedupCalls).toEqual([created.id])
    })
})

describe('SyncEngine.handleRealtimeEvent notify → work-graph ingest', () => {
    function makeEngine(): { engine: SyncEngine; store: Store } {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )
        engine.setHubOwnerUserId(7)
        return { engine, store }
    }

    it('captures AGENT_NOTIFY_SUMMARY from message-received (display cannot gate)', () => {
        const { engine, store } = makeEngine()
        const session = store.sessions.getOrCreateSession(
            'notify-wiring',
            { path: '/tmp', host: 'h', flavor: 'claude' },
            null,
            'default'
        )
        // Ensure cache has the session for ingest namespace/flavor lookup.
        engine.handleRealtimeEvent({
            type: 'session-updated',
            sessionId: session.id
        })

        const messageTs = 1_660_000_000_000
        engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: {
                id: 'msg-wire-1',
                seq: 1,
                localId: null,
                createdAt: messageTs,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                content: [{
                                    type: 'text',
                                    text: 'Done.\n\nAGENT_NOTIFY_SUMMARY {"status":"done","summary":"Wired through engine","project":"hapi"}'
                                }]
                            }
                        }
                    }
                }
            }
        })

        const rows = store.workGraph.listByRelatedSession('default', session.id)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.summary).toBe('Wired through engine')
        expect(rows[0]!.ts).toBe(messageTs)
        expect(rows[0]!.provenance).toBe('AGENT_NOTIFY_SUMMARY')
        expect(rows[0]!.payloadJson).toMatchObject({ status: 'done' })
    })

    it('does not ingest when the footer is missing', () => {
        const { engine, store } = makeEngine()
        const session = store.sessions.getOrCreateSession(
            'notify-wiring-none',
            { path: '/tmp', host: 'h', flavor: 'claude' },
            null,
            'default'
        )
        engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id })
        engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: {
                id: 'msg-wire-none',
                seq: 1,
                localId: null,
                createdAt: Date.now(),
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: { content: [{ type: 'text', text: 'No footer here.' }] }
                        }
                    }
                }
            }
        })
        expect(store.workGraph.listByRelatedSession('default', session.id)).toHaveLength(0)
    })

    it('captures notify footers from AGY agy_message envelopes', () => {
        const { engine, store } = makeEngine()
        const session = store.sessions.getOrCreateSession(
            'notify-wiring-agy',
            { path: '/tmp', host: 'h', flavor: 'agy' },
            null,
            'default'
        )
        engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id })
        engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: {
                id: 'msg-wire-agy',
                seq: 1,
                localId: null,
                createdAt: 1_670_000_000_000,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'agy_message',
                            content: 'PINGOK\n\nAGENT_NOTIFY_SUMMARY {"status":"done","summary":"AGY footer","agent":"forged-peer"}'
                        }
                    }
                }
            }
        })

        const rows = store.workGraph.listByRelatedSession('default', session.id)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.summary).toBe('AGY footer')
        expect(rows[0]!.principal).toEqual({
            kind: 'agent',
            id: `session:${session.id}`,
            on_behalf_of: '7'
        })
        expect(rows[0]!.payloadJson).toMatchObject({ agent: 'forged-peer' })
    })

    it('does not persist footer summary beyond WORK_GRAPH_MAX_SUMMARY (S4)', () => {
        const { engine, store } = makeEngine()
        const session = store.sessions.getOrCreateSession(
            'notify-wiring-bound',
            { path: '/tmp', host: 'h', flavor: 'claude' },
            null,
            'default'
        )
        engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id })

        const oversized = 'y'.repeat(WORK_GRAPH_MAX_SUMMARY + 1)
        engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId: session.id,
            message: {
                id: 'msg-wire-bound',
                seq: 1,
                localId: null,
                createdAt: Date.now(),
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                content: [{
                                    type: 'text',
                                    text: `Done.\n\nAGENT_NOTIFY_SUMMARY {"status":"done","summary":${JSON.stringify(oversized)}}`
                                }]
                            }
                        }
                    }
                }
            }
        })

        const rows = store.workGraph.listByRelatedSession('default', session.id)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.summary?.length).toBe(WORK_GRAPH_MAX_SUMMARY)
        expect(rows[0]!.summary?.length).toBeLessThan(oversized.length)
    })
})
