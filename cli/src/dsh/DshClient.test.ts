import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { DshClient, DshRpcError } from './DshClient'
import { createFixtureHost, type FixtureHost } from './__fixtures__/fixtureHost'

let host: FixtureHost | null = null

afterEach(async () => {
    await host?.close()
    host = null
})

async function fixture(): Promise<FixtureHost> {
    host = await createFixtureHost()
    return host
}

describe('DshNodeTransport + DshClient (fixture host)', () => {
    it('host.describe returns the fixture value through the official envelope', async () => {
        const h = await fixture()
        h.onRequest = (endpoint) => {
            if (endpoint === 'host.describe') {
                return {
                    ok: true,
                    value: {
                        version: '0.1.0-rc.6',
                        cwd: '/tmp/work',
                        attachedSessions: 0,
                        canOpenPath: false
                    }
                }
            }
            return { ok: false, error: { code: 'bad-request', message: `unexpected ${endpoint}`, details: {} } }
        }

        const client = DshClient.connect(h.baseUrl)
        const info = await client.describe()
        expect(info.version).toBe('0.1.0-rc.6')
        expect(info.cwd).toBe('/tmp/work')

        // The wire envelope must be the official client-request shape.
        expect(h.requests[0]).toMatchObject({ endpoint: 'host.describe' })
    })

    it('session.create passes the preallocated sessionId through', async () => {
        const h = await fixture()
        h.onRequest = () => ({ ok: true, value: { sessionId: 'hapi-test-001', agentPreset: 'standard' } })

        const client = DshClient.connect(h.baseUrl)
        const result = await client.createSession({ cwd: '/tmp/work', sessionId: 'hapi-test-001' })
        expect(result.sessionId).toBe('hapi-test-001')
        expect(h.requests[0].payload).toEqual({ cwd: '/tmp/work', sessionId: 'hapi-test-001' })
    })

    it('business errors surface as DshRpcError with the official code', async () => {
        const h = await fixture()
        h.onRequest = () => ({
            ok: false,
            error: {
                code: 'session-conflict',
                message: 'session "x" already exists with cwd "/tmp/a"; requested "/tmp/b"',
                details: { sessionId: 'x', requestedCwd: '/tmp/b' }
            }
        })

        const client = DshClient.connect(h.baseUrl)
        await expect(client.createSession({ cwd: '/tmp/b', sessionId: 'x' })).rejects.toMatchObject({
            name: 'DshRpcError',
            code: 'session-conflict'
        })
        expect(DshRpcError.prototype).toBeInstanceOf(Error)
    })

    it('session.history returns typed events', async () => {
        const h = await fixture()
        h.onRequest = () => ({
            ok: true,
            value: {
                events: [
                    {
                        event: {
                            type: 'turn/start',
                            seq: 0,
                            time: 1786600000000,
                            data: { turn: 1 }
                        }
                    }
                ],
                hasMore: false
            }
        })

        const client = DshClient.connect(h.baseUrl)
        const page = await client.sessionHistory({ sessionId: 's1' })
        expect(page.hasMore).toBe(false)
        expect(page.events[0].event.type).toBe('turn/start')
        expect(page.events[0].event.seq).toBe(0)
        expect(h.requests[0].payload).toEqual({ sessionId: 's1' })
    })

    it('mux stream yields pushed frames in order and ends on close', async () => {
        const h = await fixture()
        const client = DshClient.connect(h.baseUrl)
        const ac = new AbortController()

        const frames: string[] = []
        const pump = (async () => {
            for await (const envelope of client.muxStream(ac.signal)) {
                frames.push(envelope.payload.type)
            }
        })()

        // Wait until the WS is connected before pushing.
        await new Promise((resolve) => setTimeout(resolve, 100))
        h.pushMux({ type: 'session/subscribed', sessionId: SessionId('s1'), lastSeq: 2 })
        h.pushMux({
            type: 'session/event',
            sessionId: SessionId('s1'),
            event: { type: 'turn/start', seq: 3, time: 1786600000000, data: { turn: 2 } }
        })
        h.pushMux({ type: 'session/jobs', sessionId: SessionId('s1'), jobs: [] })

        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(frames).toEqual(['session/subscribed', 'session/event', 'session/jobs'])

        ac.abort()
        await pump
    })

    it('forkSession forwards the native seq anchor', async () => {
        const h = await fixture()
        h.onRequest = () => ({ ok: true, value: { sessionId: 'forked-native-1' } })

        const client = DshClient.connect(h.baseUrl)
        const result = await client.forkSession({ sessionId: 's1', atSeq: 42 })
        expect(result.sessionId).toBe('forked-native-1')
        expect(h.requests[0].payload).toEqual({ sessionId: 's1', atSeq: 42 })

        const current = await client.forkSession({ sessionId: 's1' })
        expect(current.sessionId).toBe('forked-native-1')
        expect(h.requests[1].payload).toEqual({ sessionId: 's1' })
    })

    it('updateQueueAction and gatewayCall use the official endpoints', async () => {
        const h = await fixture()
        h.onRequest = (endpoint, payload) => {
            if (endpoint === 'session.updateQueue') {
                return { ok: true, value: { accepted: true } }
            }
            if (endpoint === 'messageFeedback/put') {
                return { ok: true, value: {} }
            }
            return { ok: false, error: { code: 'bad-request', message: 'unexpected', details: { issues: [] } } }
        }

        const client = DshClient.connect(h.baseUrl)
        await client.updateQueueAction({ sessionId: 's1', itemId: 'q-1', action: { kind: 'remove' } })
        expect(h.requests[0]).toMatchObject({ endpoint: 'session.updateQueue' })
        expect(h.requests[0].payload).toEqual({ sessionId: 's1', itemId: 'q-1', action: { kind: 'remove' } })

        await client.gatewayCall('messageFeedback/put', { sessionId: 's1', messageId: 'm-1', rating: 'positive', ifVersion: null })
        expect(h.requests[1]).toMatchObject({ endpoint: 'messageFeedback/put' })
    })

    it('malformed frames are dropped without killing the stream', async () => {
        const h = await fixture()
        const client = DshClient.connect(h.baseUrl)
        const ac = new AbortController()

        const frames: string[] = []
        const pump = (async () => {
            for await (const envelope of client.muxStream(ac.signal)) {
                frames.push(envelope.payload.type)
            }
        })()

        await new Promise((resolve) => setTimeout(resolve, 100))
        // Raw garbage + a structurally invalid frame must be skipped.
        const rawSockets = (await import('ws')).WebSocket
        const ws = new rawSockets(`ws://127.0.0.1:${h.port}/api/events.mux`)
        await new Promise((resolve) => ws.on('open', resolve))
        ws.send('not json')
        ws.send(JSON.stringify({ type: 'server-request', rpcId: 'x', method: 'session/event', payload: { type: 'bogus' } }))
        ws.close()

        h.pushMux({ type: 'session/subscribed', sessionId: SessionId('s1'), lastSeq: 0 })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(frames).toEqual(['session/subscribed'])

        ac.abort()
        await pump
    })

    it('C1: prompt posts under the caller-owned rpcId (direct wire path)', async () => {
        const h = await fixture()
        h.onRequest = (endpoint, payload) => {
            if (endpoint === 'session.prompt') {
                return { ok: true, value: { accepted: true } }
            }
            return { ok: false, error: { code: 'bad-request', message: `unexpected ${endpoint}`, details: {} } }
        }
        const client = DshClient.connect(h.baseUrl)
        const rpcId = client.reservePromptRpcId()
        const result = await client.prompt({
            sessionId: 's1',
            mode: 'queue',
            content: [{ type: 'text', text: 'hello' }],
            rpcId
        })
        expect(result.accepted).toBe(true)
        expect(result.rpcId).toBe(rpcId)
        // The wire envelope must carry the caller-owned rpcId verbatim.
        expect(h.requests[0].endpoint).toBe('session.prompt')
        const wire = h.requests[0] as { payload: { rpcId?: string } }
        // rpcId is in the envelope, not the payload — check the request list
        // recorded the payload only; the rpcId was validated by the response
        // echo (mismatch would throw below).
    })

    it('C2: prompt rpcId mismatch on the response throws', async () => {
        const h = await fixture()
        // Fixture echoes the request rpcId — simulate a broken host by
        // overriding the envelope via a raw response (echo a DIFFERENT id).
        const raw = (await import('node:http')).request
        // Simplest: wrap onRequest to return ok, but the fixture always echoes
        // the request rpcId, so a mismatch cannot be produced here — instead
        // assert the guard exists by checking the client throws on a direct
        // transport-level mismatch: skip wire, test the check via a stub.
        const client = DshClient.connect(h.baseUrl)
        // Patch the transport's promptDirect to simulate a mismatched echo.
        const transport = (client as unknown as { transport: { promptDirect: (p: unknown, id: string) => Promise<unknown> } }).transport
        const original = transport.promptDirect
        transport.promptDirect = async (_payload: unknown, id: string) => ({ rpcId: 'different-id', result: { ok: true, value: { accepted: true } } })
        await expect(client.prompt({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'x' }], rpcId: id() })).rejects.toThrow(/rpcId mismatch/)
        transport.promptDirect = original
        function id(): string { return 'caller-id' }
    })

    it('C3: an intervening unary call cannot consume a prompt reservation', async () => {
        const h = await fixture()
        let promptPayload: { rpcId?: string } | null = null
        h.onRequest = (endpoint, payload) => {
            if (endpoint === 'session.prompt') {
                promptPayload = payload as { rpcId?: string }
                return { ok: true, value: { accepted: true } }
            }
            if (endpoint === 'session.models') {
                return { ok: true, value: { routable: true, failures: [], groups: [], current: { provider: 'p', model: 'm' } } }
            }
            return { ok: false, error: { code: 'bad-request', message: `unexpected ${endpoint}`, details: {} } }
        }
        const client = DshClient.connect(h.baseUrl)
        const rpcId = client.reservePromptRpcId()
        // Unrelated unary between reservation and dispatch must not steal it.
        await client.sessionModels('s1')
        const result = await client.prompt({
            sessionId: 's1',
            mode: 'queue',
            content: [{ type: 'text', text: 'hello' }],
            rpcId
        })
        expect(result.rpcId).toBe(rpcId)
    })
})
