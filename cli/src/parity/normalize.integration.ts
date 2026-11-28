import { describe, expect, it } from 'vitest'
import type { Row } from './fakeHub'
import { normalize } from './normalize'

const now = Date.now()
const facts = {
    out: '/tmp/parity', cli: '/repo/cli', marker: 'Thu Nov 19 11:00:00 2026', pid: 42,
    mcpPort: 18123, apiUrl: 'http://127.0.0.1:18124', startedAt: now, endedAt: now
}
function row(event: string, arg: unknown, step = 1): Row {
    return { event, args: [arg], step, connection: 1, ackRequested: false }
}
const clean = (rows: Row[]) => normalize(rows, facts, [], [])

describe('transcript normalization', () => {
    it('assigns UUIDs in channel order while retaining references and same-channel order', () => {
        const a = 'c1111111-1111-4111-8111-111111111111'
        const b = 'd2222222-2222-4222-8222-222222222222'
        const metadata = row('update-metadata', { id: a })
        const first = row('message', { id: b })
        const second = row('message', { parentUuid: b, id: a })
        expect(clean([metadata, first, second])).toEqual(clean([first, second, metadata]))
        expect(clean([metadata, second, first])).not.toEqual(clean([first, second, metadata]))
    })

    it('records a stable reconnect clientId without shifting the session UUID', () => {
        const sessionId = 'c1111111-1111-4111-8111-111111111111'
        const clientInstanceId = 'd2222222-2222-4222-8222-222222222222'
        const auth = (id: string) => ({ clientType: 'session-scoped', sessionId, clientInstanceId: id })
        const first = row('auth', auth(clientInstanceId))
        const reconnected = { ...row('auth', auth(clientInstanceId), 2), connection: 2 }
        const result = clean([first, reconnected])
        for (const key of ['1/auth', '2/auth']) {
            expect(result.channels[key][0]).toMatchObject({
                args: [{ clientInstanceId: '<client-instance:1>', sessionId: '<uuid:1>' }],
            })
        }
        expect(() => clean([row('auth', auth('invalid'))])).toThrow('clientInstanceId')
    })

    it('retains the order of chat output and pickup receipts across unrelated metadata', () => {
        const message = row('message', { text: 'before pickup' })
        const pickup = row('messages-consumed', { localIds: ['next'] })
        const metadata = row('update-metadata', {})
        expect(clean([message, metadata, pickup])).toEqual(clean([metadata, message, pickup]))
        expect(clean([message, metadata, pickup])).not.toEqual(clean([pickup, metadata, message]))
    })

    it('retains dispatch before consumption for the same steered message', () => {
        const dispatch = row('messages-steer-state', { state: 'dispatching', localIds: ['local-2'] })
        const consumed = row('messages-consumed', { steered: true, localIds: ['local-2'] })
        expect(clean([dispatch, consumed])).not.toEqual(clean([consumed, dispatch]))
    })

    it('keeps tool input clocks literal in the wire and decoded content', () => {
        const input = { time: 30, timestamp: 'tomorrow' }
        const tool = { type: 'tool_use', input }
        const data = { message: { content: [tool] } }
        const message = { content: { type: 'output', data } }
        const result = normalize([row('message', { message })], facts, [], [{ content: [tool] }])
        expect(result.channels['1/chat'][0]).toMatchObject({ args: [{ message }] })
        expect(result.decoded).toEqual([{ content: [tool] }])
    })

    it('rejects an RPC registration that requests an acknowledgement', () => {
        expect(() => clean([{ ...row('rpc-register', { method: 's:abort' }), ackRequested: true }])).toThrow('fire-and-forget')
    })

    it.each([
        row('session-alive', { time: 0 }),
        row('message', { createdAt: Math.floor(now / 1000) }),
        row('update-state', { agentState: { completedRequests: { tool: { completedAt: now + 1 } } } }),
        ...[now, '11/19/2026', new Date(now + 60000).toISOString()].map(timestamp =>
            row('message', { message: { content: { data: { timestamp } } } })),
        row('message', { message: { content: { data: { message: { content: [{ permissions: { date: 0 } }] } } } } }),
    ])('rejects invalid protocol clocks %j', entry => {
        expect(() => clean([entry])).toThrow()
    })

    it.each([
        { path: 'session-hook-43.json' },
        { method: 'sid:killSession/process/machine/43' }, { hapiMcpUrl: 'http://127.0.0.1:18122/' },
        { url: 'http://127.0.0.1:99999/' }
    ])('rejects invalid process data %j', arg => {
        expect(() => clean([row('message', arg)])).toThrow()
    })

    it('maps the compiled runtime and its tools to the source layout', () => {
        const runtimeDir = '/tmp/parity/hapi/runtime/0.36.5'
        const layout = (dir: string, tools = dir) => [row('update-metadata', {
            happyLibDir: dir, happyToolsDir: tools + '/tools/unpacked'
        })]
        expect(normalize(layout(runtimeDir), { ...facts, runtimeDir }, [], [])).toEqual(clean(layout(facts.cli)))
        expect(() => clean(layout(runtimeDir))).toThrow()
        expect(() => normalize(layout(runtimeDir, facts.cli), { ...facts, runtimeDir }, [], [])).toThrow()
    })

    it('requires the envelope to retain the timestamp of Claude output', () => {
        const message = { content: { type: 'output', data: { timestamp: new Date(now - 1).toISOString() } } }
        expect(() => clean([row('message', { message, createdAt: now })])).toThrow('Claude output creation time')
        expect(() => clean([row('message', { message, createdAt: now - 1 })])).not.toThrow()
    })

    it('preserves user date values', () => {
        expect(JSON.stringify(clean([row('message', { arguments: { date: 'tomorrow' } })]))).toContain('tomorrow')
    })

    it.each([
        row('session-alive', { sid: 's', thinking: false }),
        { ...row('session-alive', { time: now }), ackRequested: true },
        { ...row('session-alive', { time: now }), args: [{ time: now }, {}] }
    ])('rejects malformed heartbeat envelopes', heartbeat => {
        expect(() => clean([heartbeat])).toThrow()
    })

    it('normalizes the session UUID in HTTP event paths', () => {
        const id = 'a1111111-1111-4111-8111-111111111111'
        expect(clean([row('GET /cli/sessions/' + id + '/messages', {})]).channels['1/http'][0])
            .toMatchObject({ event: 'GET /cli/sessions/<uuid:1>/messages' })
    })

    it('compares the endpoints of volatile heartbeat delivery per connection', () => {
        const first = row('session-alive', { sid: 's', time: now, thinking: false })
        const intermediate = row('session-alive', { sid: 's', time: now, thinking: true })
        const last = row('session-alive', { sid: 's', time: now, thinking: false, mode: 'remote' }, 2)
        expect(clean([first, intermediate, intermediate, last])).toEqual(clean([first, last]))
        expect(clean([first, intermediate])).not.toEqual(clean([first, last]))
    })
})
