import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DshProjectedMessage } from '@/agent/types'
import { DshClient } from './DshClient'
import { DshEventBridge } from './DshEventBridge'
import { DshProjector } from './DshProjector'
import { createFixtureHost, type FixtureHost } from './__fixtures__/fixtureHost'
import type { DshPendingApproval, DshStateSnapshot } from '@hapi/protocol'

const SESSION = 'hapi-session-1'

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
}

function setup(): { bridge: DshEventBridge; sink: Sink; client: DshClient } {
    const h = host!
    const client = DshClient.connect(h.baseUrl)
    const sink: Sink = {
        messages: [],
        snapshots: [],
        approvals: [],
        resolved: [],
        statuses: [],
        errors: [],
        cursor: 0
    }
    const bridge = new DshEventBridge({
        client,
        dshSessionId: SESSION,
        projector: new DshProjector(SESSION),
        onMessage: (m) => sink.messages.push(m),
        onStateSnapshot: (s) => sink.snapshots.push(s),
        onApprovalPending: (a) => sink.approvals.push(a),
        onApprovalResolved: (id) => sink.resolved.push(id),
        onHostStatus: (r) => sink.statuses.push(r),
        onAgentError: (e) => sink.errors.push(e),
        onCursor: (seq) => { sink.cursor = seq },
        logTag: 'test'
    })
    return { bridge, sink, client }
}

describe('DshEventBridge', () => {
    it('projects session events and advances the cursor', async () => {
        host = await createFixtureHost()
        const { bridge, sink, client } = setup()
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        await new Promise((resolve) => setTimeout(resolve, 100))
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(SESSION),
            event: {
                type: 'turn/start',
                seq: 0,
                time: 1786600000000,
                data: { turn: 1 }
            }
        })
        host.pushMux({
            type: 'session/event',
            sessionId: SessionId(SESSION),
            event: {
                type: 'turn/end',
                seq: 1,
                time: 1786600000001,
                data: { turn: 1, reason: { kind: 'completed' } }
            }
        })
        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(sink.messages.some((m) => m.type === 'dsh_native' && m.event.type === 'turn/start')).toBe(true)
        expect(sink.messages.some((m) => m.type === 'turn_complete')).toBe(true)
        expect(sink.cursor).toBe(1)

        ac.abort()
        await pump
    })

    it('tracks approvals through requested/resolved with state snapshots', async () => {
        host = await createFixtureHost()
        const { bridge, sink, client } = setup()
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        await new Promise((resolve) => setTimeout(resolve, 100))
        host.pushMux({
            type: 'approval/requested',
            sessionId: SessionId(SESSION),
            approvalId: 'approval-1' as never,
            toolName: 'bash'
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(sink.approvals).toEqual([{ approvalId: 'approval-1', toolName: 'bash' }])
        expect(sink.snapshots.at(-1)?.approvals).toEqual([{ approvalId: 'approval-1', toolName: 'bash' }])

        host.pushMux({
            type: 'approval/resolved',
            sessionId: SessionId(SESSION),
            approvalId: 'approval-1' as never,
            outcome: 'allowed-once'
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(sink.resolved).toEqual(['approval-1'])
        expect(sink.snapshots.at(-1)?.approvals).toEqual([])

        ac.abort()
        await pump
    })

    it('folds queue/jobs/projection frames into dsh_state snapshots', async () => {
        host = await createFixtureHost()
        const { bridge, sink, client } = setup()
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        await new Promise((resolve) => setTimeout(resolve, 100))
        host.pushMux({
            type: 'session/queue',
            sessionId: SessionId(SESSION),
            items: [{
                id: 'q-1' as never,
                placement: 'queued',
                message: {
                    id: 'm-1' as never,
                    role: 'user',
                    content: [{ type: 'text', text: 'second prompt' }],
                    source: { kind: 'user', rpcId: 'rpc-q1' } as never
                }
            }]
        })
        host.pushMux({
            type: 'session/jobs',
            sessionId: SessionId(SESSION),
            jobs: [{
                id: 'bash-1' as never,
                kind: 'bash',
                label: 'bun run build',
                status: 'running',
                startedAt: 1786600000000
            }]
        })
        host.pushMux({
            type: 'session/projection',
            sessionId: SessionId(SESSION),
            key: 'goal',
            value: { objective: 'ship it', status: 'active', revision: 1 },
            seq: 5
        })
        await new Promise((resolve) => setTimeout(resolve, 100))

        const last = sink.snapshots.at(-1)
        expect(last?.queue?.items).toEqual([{ id: 'q-1', placement: 'queued', text: 'second prompt' }])
        expect(last?.jobs?.jobs).toHaveLength(1)
        expect(last?.goal).toMatchObject({ objective: 'ship it', status: 'active' })
        expect(sink.messages.some((m) => m.type === 'dsh_native' && m.event.type === 'projection/goal')).toBe(false)

        ac.abort()
        await pump
    })

    it('persists non-goal projection keys as dsh_native', async () => {
        host = await createFixtureHost()
        const { bridge, sink, client } = setup()
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        await new Promise((resolve) => setTimeout(resolve, 100))
        host.pushMux({
            type: 'session/projection',
            sessionId: SessionId(SESSION),
            key: 'sessionStats',
            value: { turns: 3 },
            seq: 6
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(sink.messages.some((m) => m.type === 'dsh_native' && m.event.type === 'projection/sessionStats')).toBe(true)

        ac.abort()
        await pump
    })

    it('surfaces host status flips and agent errors', async () => {
        host = await createFixtureHost()
        const { bridge, sink, client } = setup()
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        await new Promise((resolve) => setTimeout(resolve, 100))
        host.pushHost({ type: 'host/session-status', sessionId: SessionId(SESSION), running: true })
        host.pushHost({ type: 'host/agent-error', sessionId: SessionId(SESSION), message: 'boom' })
        host.pushHost({ type: 'host/session-status', sessionId: SessionId(SESSION), running: false })
        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(sink.statuses).toEqual([true, false])
        expect(sink.errors).toEqual(['boom'])
        expect(sink.snapshots.at(-1)?.running).toBe(false)

        ac.abort()
        await pump
    })
})
