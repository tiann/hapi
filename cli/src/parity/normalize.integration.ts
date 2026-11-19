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

    it.each([
        { time: 0 }, { createdAt: Math.floor(now / 1000) }, { completedAt: now + 1 },
        { timestamp: now }, { timestamp: '11/19/2026' }, { timestamp: new Date(now + 60000).toISOString() },
        { permissions: { date: 0 } }, { path: 'session-hook-43.json' },
        { method: 'sid:killSession/process/machine/43' }, { hapiMcpUrl: 'http://127.0.0.1:18122/' },
        { url: 'http://127.0.0.1:99999/' }
    ])('rejects invalid process or clock data %j', arg => {
        expect(() => clean([row('message', arg)])).toThrow()
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
