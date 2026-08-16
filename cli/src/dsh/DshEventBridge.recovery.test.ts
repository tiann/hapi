import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { DshProjectedMessage } from '@/agent/types'
import { DshClient } from './DshClient'
import { DshEventBridge } from './DshEventBridge'
import { DshProjector } from './DshProjector'
import { createFixtureHost, type FixtureHost } from './__fixtures__/fixtureHost'
import type { DshPendingApproval, DshStateSnapshot } from '@hapi/protocol'

/**
 * P0 recovery-state-machine coverage (TEST-PLAN.md A-series): reconnect,
 * backfill failure, buffering races, child journal recovery, projection
 * ordering. These are the paths the review bots keep flagging — every fix
 * in rounds 4-21 of PR #1574 is exercised here.
 */

const SESSION = 'hapi-session-1'
const CHILD = 'child-session-1'
const WAIT = 150

let host: FixtureHost | null = null

afterEach(async () => {
    await host?.close()
    host = null
})

type Sink = {
    messages: DshProjectedMessage[]
    snapshots: DshStateSnapshot[]
    approvals: DshPendingApproval[]
    resolved: string[]
    statuses: boolean[]
    errors: string[]
    cursor: number
    childCursors: Array<{ childId: string; seq: number }>
    ready: boolean
}

function setup(options?: {
    initialCursor?: number
    initialChildCursors?: Record<string, number>
    history?: (payload: { beforeSeq?: number; maxMessages?: number }) => unknown
}): { bridge: DshEventBridge; sink: Sink; client: DshClient } {
    const h = host!
    h.subscribedOnOpen = { sessionId: SESSION, lastSeq: 0 }
    if (options?.history) {
        const original = h.onRequest
        h.onRequest = async (endpoint, payload) => {
            if (endpoint === 'session.history') {
                // Await: async handlers return Promise<undefined> which would
                // otherwise pass the !== undefined check and reach the server
                // as an undefined result.
                const custom = await options.history!(payload as { beforeSeq?: number; maxMessages?: number })
                if (custom !== undefined) return custom
            }
            return original(endpoint, payload)
        }
    }
    const client = DshClient.connect(h.baseUrl)
    const sink: Sink = {
        messages: [],
        snapshots: [],
        approvals: [],
        resolved: [],
        statuses: [],
        errors: [],
        cursor: 0,
        childCursors: [],
        ready: false
    }
    const bridge = new DshEventBridge({
        client,
        dshSessionId: SESSION,
        projector: new DshProjector(SESSION),
        ...(options?.initialCursor !== undefined ? { initialCursor: options.initialCursor } : {}),
        ...(options?.initialChildCursors ? { initialChildCursors: options.initialChildCursors } : {}),
        onMessage: (m, source) => sink.messages.push(m),
        onStateSnapshot: (s) => sink.snapshots.push(s),
        onApprovalPending: (a) => sink.approvals.push(a),
        onApprovalResolved: (id) => sink.resolved.push(id),
        onHostStatus: (r) => sink.statuses.push(r),
        onAgentError: (e) => sink.errors.push(e),
        onCursor: (seq) => { sink.cursor = seq },
        onChildCursor: (childId, seq) => sink.childCursors.push({ childId, seq }),
        onReady: () => { sink.ready = true },
        logTag: 'test'
    })
    return { bridge, sink, client }
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
    const start = Date.now()
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('waitFor timed out')
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

const ev = (type: string, seq: number, data: Record<string, unknown> = {}): SessionEvent => ({
    type: type as SessionEvent['type'],
    seq,
    time: 1_786_600_000_000 + seq,
    data
}) as unknown as SessionEvent

function nativeOf(sink: Sink, type: string, dshSessionId = SESSION): DshProjectedMessage | undefined {
    return sink.messages.find((m) => m.type === 'dsh_native' && m.event.type === type && m.event.dshSessionId === dshSessionId)
}

describe('DshEventBridge recovery (P0)', () => {
    it('A1: first generation backfills history after the root subscription', async () => {
        host = await createFixtureHost()
        const { bridge, sink, client } = setup({
            history: () => ({
                ok: true,
                value: {
                    events: [
                        { event: ev('turn/start', 1, { turn: 1 }) },
                        { event: ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }) }
                    ],
                    hasMore: false
                }
            })
        })
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        await waitFor(() => sink.cursor === 2)
        expect(nativeOf(sink, 'turn/start')).toBeDefined()
        expect(sink.messages.some((m) => m.type === 'turn_complete')).toBe(true)
        // Gap-free: exactly one turn/start native row.
        expect(sink.messages.filter((m) => m.type === 'dsh_native' && m.event.type === 'turn/start')).toHaveLength(1)

        ac.abort()
        await pump
    })

    it('A2: live root events arriving during the initial backfill are buffered and replayed', async () => {
        host = await createFixtureHost()
        const { bridge, sink, client } = setup({
            history: async () => {
                // Slow history: live events arrive while it is in flight.
                await new Promise((resolve) => setTimeout(resolve, 300))
                return { ok: true, value: { events: [], hasMore: false } }
            }
        })
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        await new Promise((resolve) => setTimeout(resolve, WAIT))
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(SESSION),
            event: ev('turn/start', 1, { turn: 1 })
        })
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(SESSION),
            event: ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } })
        })

        await waitFor(() => sink.cursor === 2)
        expect(nativeOf(sink, 'turn/start')).toBeDefined()
        expect(sink.messages.filter((m) => m.type === 'dsh_native' && m.event.type === 'turn/start')).toHaveLength(1)

        ac.abort()
        await pump
    })

    it('A3: a failed backfill aborts the generation and retries successfully', async () => {
        host = await createFixtureHost()
        let calls = 0
        const { bridge, sink, client } = setup({
            history: () => {
                calls++
                if (calls === 1) {
                    throw new Error('transient history failure')
                }
                return {
                    ok: true,
                    value: {
                        events: [{ event: ev('turn/start', 1, { turn: 1 }) }],
                        hasMore: false
                    }
                }
            }
        })
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        await waitFor(() => sink.cursor === 1, 8_000)
        expect(calls).toBeGreaterThanOrEqual(2)
        expect(nativeOf(sink, 'turn/start')).toBeDefined()

        ac.abort()
        await pump
    })

    it('A4: host stream closing before the root subscription triggers reconnect (no hang)', async () => {
        host = await createFixtureHost()
        const { bridge, sink, client } = setup({})
        // No subscribedOnOpen for the first attempt: the host stream dies
        // before any subscription frame, so attached must resolve false.
        host.subscribedOnOpen = null
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        await new Promise((resolve) => setTimeout(resolve, WAIT))
        host.disconnectHost()
        await waitFor(() => host!.muxSocketCount() === 0 || sink.statuses.length > 0, 2_000)
        // Re-arm the subscription for the next generation, then confirm the
        // bridge reconnects and forwards live events.
        host.subscribedOnOpen = { sessionId: SESSION, lastSeq: 0 }
        await new Promise((resolve) => setTimeout(resolve, 1_200))
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(SESSION),
            event: ev('turn/start', 1, { turn: 1 })
        })
        await waitFor(() => sink.cursor === 1, 8_000)
        expect(nativeOf(sink, 'turn/start')).toBeDefined()

        ac.abort()
        await pump
    })

    it('A5: reconnect gap-fills from the last forwarded seq without duplicates', async () => {
        host = await createFixtureHost()
        let historyCalls = 0
        const { bridge, sink, client } = setup({
            history: (payload) => {
                // Only backfill pages (maxMessages 200) count; the projection
                // bootstrap probes with maxMessages 1.
                if (payload?.maxMessages !== 200) return undefined
                historyCalls++
                // First call = initial backfill (empty). Reconnect backfill
                // serves events 1-2 (already forwarded) plus 3 (the gap).
                if (historyCalls === 1) {
                    return { ok: true, value: { events: [], hasMore: false } }
                }
                return {
                    ok: true,
                    value: {
                        events: [
                            { event: ev('turn/start', 1, { turn: 1 }) },
                            { event: ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }) },
                            { event: ev('turn/start', 3, { turn: 2 }) }
                        ],
                        hasMore: false
                    }
                }
            }
        })
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        // Live events 1-2 arrive first.
        await waitFor(() => sink.cursor === 0 || true)
        await new Promise((resolve) => setTimeout(resolve, WAIT))
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(SESSION),
            event: ev('turn/start', 1, { turn: 1 })
        })
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(SESSION),
            event: ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } })
        })
        await waitFor(() => sink.cursor === 2)

        // Outage: event 3 is committed while disconnected; reconnect must
        // gap-fill it without re-forwarding 1-2.
        host.disconnectMux()
        await new Promise((resolve) => setTimeout(resolve, 1_200))

        await waitFor(() => sink.cursor === 3, 8_000)
        const starts = sink.messages.filter((m) => m.type === 'dsh_native' && m.event.type === 'turn/start')
        expect(starts).toHaveLength(2) // turns 1 and 2, exactly once each
        expect(starts.some((m) => (m as { event: { seq: number } }).event.seq === 3)).toBe(true)

        ac.abort()
        await pump
    }, 20_000)

    it('A6: live events arriving before the reconnect backfill are buffered (no loss)', async () => {
        host = await createFixtureHost()
        let historyCalls = 0
        const { bridge, sink, client } = setup({
            history: async (payload) => {
                if (payload?.maxMessages !== 200) return undefined
                historyCalls++
                if (historyCalls === 1) {
                    return { ok: true, value: { events: [], hasMore: false } }
                }
                // Slow reconnect backfill: live event 3 arrives while in flight.
                await new Promise((resolve) => setTimeout(resolve, 300))
                return {
                    ok: true,
                    value: { events: [{ event: ev('turn/start', 3, { turn: 2 }) }], hasMore: false }
                }
            }
        })
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        await new Promise((resolve) => setTimeout(resolve, WAIT))
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(SESSION),
            event: ev('turn/start', 1, { turn: 1 })
        })
        await waitFor(() => sink.cursor === 1)

        host.disconnectMux()
        // Wait for the reconnect generation to attach AND start its backfill
        // (second maxMessages=200 history call), then push the live event so
        // it lands inside the slow backfill window.
        await waitFor(() => host!.muxSocketCount() > 0 && historyCalls >= 2, 8_000)
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(SESSION),
            event: ev('turn/start', 3, { turn: 2 })
        })

        await waitFor(() => sink.cursor === 3, 8_000)
        const starts = sink.messages.filter((m) => m.type === 'dsh_native' && m.event.type === 'turn/start')
        expect(starts).toHaveLength(2)

        ac.abort()
        await pump
    }, 20_000)

    it('A7: child events advance a per-child cursor and fire onChildCursor', async () => {
        host = await createFixtureHost()
        const { bridge, sink, client } = setup({})
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        await new Promise((resolve) => setTimeout(resolve, WAIT))
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(CHILD),
            event: ev('turn/start', 5, { turn: 1 })
        })
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(CHILD),
            event: ev('turn/end', 6, { turn: 1, reason: { kind: 'completed' } })
        })

        await waitFor(() => sink.childCursors.length >= 2)
        expect(sink.childCursors).toEqual([
            { childId: CHILD, seq: 5 },
            { childId: CHILD, seq: 6 }
        ])
        expect(nativeOf(sink, 'turn/start', CHILD)).toBeDefined()

        ac.abort()
        await pump
    })

    it('A8: unknown child events during root backfill are sealed, discovered, and replayed', async () => {
        // backoff retries need longer than the 5s default
        host = await createFixtureHost()
        const { bridge, sink, client } = setup({
            history: async () => {
                await new Promise((resolve) => setTimeout(resolve, 250))
                return { ok: true, value: { events: [], hasMore: false } }
            }
        })
        // Discovery reports the child; its journal holds events 5-6.
        const original = host.onRequest
        host.onRequest = (endpoint, payload) => {
            if (endpoint === 'subagent.list') {
                return { ok: true, value: { entries: [{ kind: 'child', id: CHILD, mode: 'continuable', activity: 'inactive', hasChildren: false, label: 'c' }], parentAvailable: true } }
            }
            if (endpoint === 'subagent.history') {
                return {
                    ok: true,
                    value: {
                        events: [
                            { event: ev('turn/start', 5, { turn: 1 }) },
                            { event: ev('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }) }
                        ],
                        hasMore: false
                    }
                }
            }
            return original(endpoint, payload)
        }
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        // Child events land DURING the root backfill (child unknown yet).
        await new Promise((resolve) => setTimeout(resolve, 100))
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(CHILD),
            event: ev('turn/start', 5, { turn: 1 })
        })

        // Child journal is replayed after discovery; the live child frame
        // must not be duplicated (it arrived while sealed).
        await waitFor(() => sink.childCursors.some((c) => c.seq === 6), 8_000)
        expect(sink.childCursors[0]).toEqual({ childId: CHILD, seq: 5 })
        expect(sink.childCursors[1]).toEqual({ childId: CHILD, seq: 6 })
        const childStarts = sink.messages.filter((m) => m.type === 'dsh_native' && m.event.type === 'turn/start' && m.event.dshSessionId === CHILD)
        expect(childStarts).toHaveLength(1)

        ac.abort()
        await pump
    }, 20_000)

    it('A9: a failed child backfill aborts the generation; the retry recovers', async () => {
        // backoff retries need longer than the 5s default
        host = await createFixtureHost()
        let childHistoryCalls = 0
        const { bridge, sink, client } = setup({})
        const original = host.onRequest
        host.onRequest = (endpoint, payload) => {
            if (endpoint === 'subagent.list') {
                return { ok: true, value: { entries: [{ kind: 'child', id: CHILD, mode: 'continuable', activity: 'running', hasChildren: false, label: 'c' }], parentAvailable: true } }
            }
            if (endpoint === 'subagent.history') {
                childHistoryCalls++
                if (childHistoryCalls === 1) {
                    throw new Error('transient subagent history failure')
                }
                return {
                    ok: true,
                    value: {
                        events: [
                            { event: ev('turn/start', 5, { turn: 1 }) },
                            { event: ev('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }) }
                        ],
                        hasMore: false
                    }
                }
            }
            return original(endpoint, payload)
        }
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        // Live child frame arriving while the failed first replay is sealed.
        await new Promise((resolve) => setTimeout(resolve, 200))
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(CHILD),
            event: ev('turn/start', 5, { turn: 1 })
        })

        await waitFor(() => sink.childCursors.length >= 1, 12_000)
        expect(childHistoryCalls).toBeGreaterThanOrEqual(2)
        const childStarts = sink.messages.filter((m) => m.type === 'dsh_native' && m.event.type === 'turn/start' && m.event.dshSessionId === CHILD)
        expect(childStarts).toHaveLength(1)

        ac.abort()
        await pump
    }, 20_000)

    it('A10: live child events during a child replay are buffered and replayed once', async () => {
        // backoff retries need longer than the 5s default
        host = await createFixtureHost()
        const { bridge, sink, client } = setup({})
        const original = host.onRequest
        host.onRequest = (endpoint, payload) => {
            if (endpoint === 'subagent.list') {
                return { ok: true, value: { entries: [{ kind: 'child', id: CHILD, mode: 'continuable', activity: 'running', hasChildren: false, label: 'c' }], parentAvailable: true } }
            }
            if (endpoint === 'subagent.history') {
                return {
                    ok: true,
                    value: { events: [{ event: ev('turn/start', 5, { turn: 1 }) }], hasMore: false }
                }
            }
            return original(endpoint, payload)
        }
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        // Wait until the child replay is in flight (history fetch started),
        // then push a live child event 6.
        await waitFor(() => host!.requests.some((r) => r.endpoint === 'subagent.history'), 4_000)
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(CHILD),
            event: ev('turn/end', 6, { turn: 1, reason: { kind: 'completed' } })
        })

        await waitFor(() => sink.childCursors.some((c) => c.seq === 6), 8_000)
        const childEnds = sink.messages.filter((m) => m.type === 'dsh_native' && m.event.type === 'turn/end' && m.event.dshSessionId === CHILD)
        expect(childEnds).toHaveLength(1)

        ac.abort()
        await pump
    }, 20_000)

    it('A13: question/resolved clears the pending question to null', async () => {
        // backoff retries need longer than the 5s default
        host = await createFixtureHost()
        const { bridge, sink, client } = setup({})
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        await new Promise((resolve) => setTimeout(resolve, WAIT))
        host.pushMux({
            type: 'question/requested',
            sessionId: SessionId(SESSION),
            questions: [{ id: 'q1', question: 'pick' }]
        })
        host.pushMux({
            type: 'question/resolved',
            sessionId: SessionId(SESSION),
            questionRpcId: RpcId('rpc-1'),
            outcome: 'answered'
        })

        await waitFor(() => sink.snapshots.length >= 2)
        const last = sink.snapshots[sink.snapshots.length - 1]
        expect(last.questions).toBeNull()

        ac.abort()
        await pump
    }, 20_000)
})
