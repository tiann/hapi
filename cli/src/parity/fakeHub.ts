import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Server, type ServerOptions, type Socket } from '../../../hub/node_modules/socket.io'
import type { UpdateMetadataAck, UpdateStateAck } from '@hapi/protocol'

import { monotonicTimeMs } from '../utils/time'

export const sid = 'a1111111-1111-4111-8111-111111111111'
export type Row = { connection: number; step: number; event: string; args: unknown[]; ackRequested: boolean; ack?: unknown[] }
export type ScriptStep =
    | { sendUpdate: Record<string, any> }
    | { rpc: string; params: unknown }
    | { dropConnection: true; backfill?: Record<string, any> }
    | { forceVersionMismatch: { event: 'update-state' | 'update-metadata'; count: number } }
    | { delayAck: number }
    | { signal: 'SIGTERM' }

export async function body(req: IncomingMessage) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
}

export async function listen(server: HttpServer) {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    return (server.address() as { port: number }).port
}

export async function fakeHub(out: string, changed: () => void = () => {}) {
    const rows: Row[] = []
    let connection = 0
    let step = 0
    const mismatches = { 'update-state': 0, 'update-metadata': 0 }
    let latestAlive: Record<string, unknown> | undefined
    let delay = 0
    const pendingAcks = new Set<NodeJS.Timeout>()
    let closed = false
    let leaseExpiry: number | undefined
    let socket: Socket
    let sequence = 0
    const messages: Record<string, any>[] = []
    const now = Date.now()
    const base = { namespace: 'default', seq: 0, active: false, activeAt: now, createdAt: now, updatedAt: now, metadataVersion: 1 }
    const session = { ...base, id: sid, thinking: false, thinkingAt: 0, metadata: null, agentState: null, agentStateVersion: 1 }
    function save() { writeFileSync(join(out, 'transcript.json'), JSON.stringify(rows, null, 2)) }
    function record(event: string, args: unknown[], ackRequested = false, ordinal = connection) {
        const row: Row = { connection: ordinal, step, event, args: structuredClone(args), ackRequested }
        rows.push(row)
        save()
        changed()
        return row
    }
    const server = createServer(async (req, res) => {
        const url = new URL(req.url!, 'http://localhost')
        const data = await body(req)
        const event = req.method + ' ' + url.pathname
        record(event, [{ body: data, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization }], false, 0)
        let response
        if (event === 'POST /cli/machines') {
            response = { machine: { ...base, ...data, runnerStateVersion: 1 } }
        } else if (event === 'POST /cli/sessions') {
            Object.assign(session, { metadata: data.metadata, agentState: data.agentState ?? null,
                model: data.model ?? null, effort: data.effort ?? null, modelReasoningEffort: data.modelReasoningEffort ?? null })
            response = { session, sessionSummaryContract: false, autoBridgeTransientModelErrors: false }
        } else if (event === 'GET /cli/sessions/' + sid) {
            response = { session, sessionSummaryContract: false, autoBridgeTransientModelErrors: false }
        } else if (event === 'GET /cli/sessions/' + sid + '/messages') {
            const afterSeq = Number(url.searchParams.get('afterSeq'))
            const limit = Number(url.searchParams.get('limit') ?? 200)
            if (!url.searchParams.has('afterSeq') || !Number.isInteger(afterSeq) || afterSeq < 0 ||
                !Number.isInteger(limit) || limit < 1 || limit > 200) {
                res.statusCode = 400
                response = { error: 'Invalid query' }
            } else response = { messages: messages.filter(m => m.seq > afterSeq).slice(0, limit) }
        } else {
            res.statusCode = 404
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(response ?? {}))
    })
    const io = new Server(server, { transports: ['websocket'] } as Partial<ServerOptions>)
    io.of('/cli').on('connection', client => {
        latestAlive = undefined
        socket = client
        const ordinal = ++connection
        record('auth', [client.handshake.auth])
        client.onAny((event: string, ...args) => {
            const cb = typeof args.at(-1) === 'function' ? args.pop() : undefined
            if (event === 'session-alive' && ordinal === connection) latestAlive = args[0]
            const row = record(event, args, Boolean(cb), ordinal)
            if (!cb) return
            let ack: unknown[] = []
            if (event === 'update-metadata' || event === 'update-state') {
                const key = event === 'update-metadata' ? 'metadata' : 'agentState'
                const version = key === 'metadata' ? 'metadataVersion' : 'agentStateVersion'
                if (mismatches[event] > 0) {
                    session[version]++
                    mismatches[event]--
                }
                const success = args[0].expectedVersion === session[version]
                if (success) {
                    session[version]++
                    session[key] = args[0][key]
                }
                const common = success ? { result: 'success' as const, version: session[version] }
                    : { result: 'version-mismatch' as const, version: session[version] }
                const answer: UpdateMetadataAck | UpdateStateAck = key === 'metadata'
                    ? { ...common, metadata: session.metadata } : { ...common, agentState: session.agentState }
                ack = [answer]
            } else if (event === 'messages-steer-state') ack = [{ ok: true }]
            const reply = () => {
                cb(...ack)
                row.ack = structuredClone(ack)
                save()
                changed()
            }
            if (delay) {
                const timer = setTimeout(() => {
                    pendingAcks.delete(timer)
                    if (!closed) reply()
                }, delay)
                pendingAcks.add(timer)
            } else reply()
        })
    })
    const port = await listen(server)
    return {
        rows, port, record, session,
        get latestAlive() { return latestAlive },
        get leaseExpiry() { return leaseExpiry },
        async execute(action: ScriptStep, kill: () => void, facts: { pid: number; marker: string }) {
            step++
            record('step', [action])
            if ('rpc' in action) {
                const params = JSON.stringify(action.params, (_, value) => {
                    if (value === '$pid') return facts.pid
                    if (value === '$marker') return facts.marker
                    if (value === '$leaseExpiry') {
                        leaseExpiry = monotonicTimeMs() + 15_000
                        return leaseExpiry
                    }
                    return value
                })
                const response = await socket.timeout(30_000).emitWithAck('rpc-request', { method: sid + ':' + action.rpc, params })
                record('rpc-ack', response === undefined ? [] : [response])
            } else if ('sendUpdate' in action) {
                const update: Record<string, any> = { ...action.sendUpdate, sid }
                for (const key of ['metadata', 'agentState'] as const) {
                    if (action.sendUpdate[key] == null) continue
                    const version = key === 'metadata' ? 'metadataVersion' : 'agentStateVersion'
                    const value = { ...session[key] as object | null, ...action.sendUpdate[key] }
                    Object.assign(session, { [key]: value, [version]: session[version] + 1 })
                    update[key] = { value, version: session[version] }
                }
                if (action.sendUpdate.message) messages.push(action.sendUpdate.message)
                const payload = { id: 'update-' + ++sequence, seq: sequence, createdAt: 1, body: update }
                if (update.t === 'cancel-queued-message' || update.t === 'retry-queued-message') {
                    record('update-ack', [await socket.timeout(30_000).emitWithAck('update', payload)])
                } else socket.emit('update', payload)
            } else if ('dropConnection' in action) {
                socket.conn.close()
                if (action.backfill) messages.push(action.backfill)
            } else if ('forceVersionMismatch' in action) mismatches[action.forceVersionMismatch.event] = action.forceVersionMismatch.count
            else if ('delayAck' in action) delay = action.delayAck
            else kill()
        },
        close: () => {
            closed = true
            for (const timer of pendingAcks) clearTimeout(timer)
            pendingAcks.clear()
            return io.close()
        }
    }
}
