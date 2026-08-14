import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startDshHost } from './DshRuntime'
import { DshClient } from './DshClient'
import { DshProjector } from './DshProjector'
import { DshEventBridge } from './DshEventBridge'
import type { DshProjectedMessage } from '@/agent/types'
import type { DshPendingApproval, DshStateSnapshot } from '@hapi/protocol'

/**
 * End-to-end session flow against a deterministic fixture DSH host running in
 * a child process over the real loopback HTTP + WebSocket wire — the same
 * production code path as a real host (spawn → connect → create-as-resume →
 * bridge → prompt → streaming → tool/approval → interrupt → stop).
 */
const FIXTURE_HOST_BIN = `
const { createServer } = require('node:http')
const { WebSocketServer } = require('WS_REQUIRE_PATH')
const args = process.argv
const port = Number(args[args.indexOf('--port') + 1])
const sessions = new Map()

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let parsed = { rpcId: 'x', method: '', payload: {} }
    try { parsed = JSON.parse(body) } catch {}
    const { rpcId, method, payload } = parsed
    const send = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
    }
    if (method === 'host.describe') {
      send({ ok: true, value: { version: '0.0.1', cwd: process.cwd(), attachedSessions: 0, canOpenPath: false } })
    } else if (method === 'session.create') {
      sessions.set(payload.sessionId, { cwd: payload.cwd, events: [] })
      send({ ok: true, value: { sessionId: payload.sessionId, agentPreset: 'standard' } })
    } else if (method === 'session.history') {
      const s = sessions.get(payload.sessionId)
      send({ ok: true, value: { events: s ? s.events : [], hasMore: false } })
    } else if (method === 'session.prompt') {
      const s = sessions.get(payload.sessionId)
      if (!s) { send({ ok: false, error: { code: 'session-not-found', message: 'missing', details: { sessionId: payload.sessionId } } }); return }
      s.prompt = payload
      send({ ok: true, value: { accepted: true } })
    } else if (method === 'session.cancel') {
      send({ ok: true, value: { accepted: true } })
    } else {
      send({ ok: false, error: { code: 'bad-request', message: 'unknown ' + method, details: { issues: [] } } })
    }
  })
})

const wss = new WebSocketServer({ noServer: true })
let muxSocket = null
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://dsh.test')
  if (url.pathname === '/api/events.mux') {
    wss.handleUpgrade(req, socket, head, (ws) => { muxSocket = ws })
    return
  }
  socket.destroy()
})
server.listen(port, '127.0.0.1')

// Deterministic scripted session: after a prompt arrives, push the full
// turn (streaming chunks, tool call, approval, result, turn end).
const push = (frame) => {
  if (!muxSocket) return
  muxSocket.send(JSON.stringify({
    type: 'server-request',
    rpcId: 'fixture-' + Math.random().toString(36).slice(2),
    method: 'session/event',
    payload: frame
  }))
}
const ev = (type, seq, data) => ({ type: 'session/event', sessionId: 's1', event: { type, seq, time: Date.now(), data } })

setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.prompt || s.played) continue
    s.played = true
    push(ev('turn/start', 1, { turn: 1 }))
    push(ev('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }))
    push(ev('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'I will' } }))
    push(ev('assistant/chunk', 4, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: ' look' } }))
    push(ev('tool/call', 5, { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}' }))
    push({ type: 'approval/requested', sessionId: 's1', approvalId: 'approval-1', toolName: 'bash' })
    push(ev('tool/result', 6, { turn: 1, step: 1, message: { id: 'm-r1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'total 4' }] }], source: { kind: 'tool', callId: 'call-1' } } }))
    push(ev('assistant/message', 7, { turn: 1, step: 1, message: { id: 'm-1', role: 'assistant', content: [{ type: 'text', text: 'I will look' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4' } }, usage: { inputTokens: 10, outputTokens: 5 } }))
    push(ev('turn/end', 8, { turn: 1, reason: { kind: 'completed' } }))
  }
}, 50)
process.on('SIGTERM', () => process.exit(0))
`

let cleanupDirs: string[] = []

afterEach(() => {
    for (const dir of cleanupDirs) {
        rmSync(dir, { recursive: true, force: true })
    }
    cleanupDirs = []
})

function fixtureBin(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-dsh-e2e-'))
    cleanupDirs.push(dir)
    const file = join(dir, 'fixture-host.js')
    const wsPath = join(__dirname, '..', '..', '..', 'node_modules', 'ws')
    writeFileSync(file, FIXTURE_HOST_BIN.replace('WS_REQUIRE_PATH', wsPath))
    return file
}

describe('DSH session end-to-end (fixture host, production paths)', () => {
    it('create → prompt → streaming → tool/approval → result → interrupt → stop', { timeout: 30_000 }, async () => {
        // Slow CI runners need headroom beyond vitest's 5s default for the
        // child-process fixture host + full scripted turn.
        const workDir = mkdtempSync(join(tmpdir(), 'hapi-dsh-e2e-work-'))
        cleanupDirs.push(workDir)
        const handle = await startDshHost({ cwd: workDir, runtimeBin: fixtureBin(), readyTimeoutMs: 10_000 })
        console.log('[dsh-e2e] host ready', handle.baseUrl)
        const client = DshClient.connect(handle.baseUrl)

        // create-as-resume mapping (HAPI id = DSH id)
        const created = await client.createSession({ cwd: workDir, sessionId: 's1' })
        expect(created.sessionId).toBe('s1')

        const projector = new DshProjector('s1')
        const messages: DshProjectedMessage[] = []
        const approvals: DshPendingApproval[] = []
        const snapshots: DshStateSnapshot[] = []
        let interruptSent = false

        const bridge = new DshEventBridge({
            client,
            dshSessionId: 's1',
            projector,
            onMessage: (m) => messages.push(m),
            onStateSnapshot: (s) => snapshots.push(s),
            onApprovalPending: (a) => approvals.push(a),
            onApprovalResolved: () => {},
            onHostStatus: () => {},
            onAgentError: () => {},
            logTag: 'e2e'
        })
        const ac = new AbortController()
        const pump = bridge.start(ac.signal)

        // Prompt → the fixture host plays the scripted turn.
        console.log('[dsh-e2e] prompting')
        await client.prompt({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'list files' }] })
        console.log('[dsh-e2e] prompted')

        // Wait for the full scripted turn.
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
            if (messages.some((m) => m.type === 'turn_complete')) break
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        console.log('[dsh-e2e] turn wait done, messages=', messages.length, 'types=', [...new Set(messages.map((m) => m.type))].join(','))

        const texts = messages.filter((m) => m.type === 'text')
        expect(texts.length).toBeGreaterThan(0)
        // Streaming live snapshots accumulated, then the final message settled.
        const live = texts.filter((m) => m.live === true)
        expect(live.map((m) => m.text)).toEqual(['I will', 'I will look'])
        const final = texts.filter((m) => m.type === 'text' && m.live !== true)
        expect(final.at(-1)).toMatchObject({ text: 'I will look', streamSnapshot: true })

        const toolCalls = messages.filter((m) => m.type === 'tool_call')
        expect(toolCalls.at(-1)).toMatchObject({ id: 'call-1', name: 'bash', input: { cmd: 'ls' } })
        const toolResults = messages.filter((m) => m.type === 'tool_result')
        expect(toolResults.at(-1)).toMatchObject({ id: 'call-1', status: 'completed' })
        expect(messages.some((m) => m.type === 'turn_complete' && m.stopReason === 'completed')).toBe(true)

        // Approval surfaced with the frame rpcId mapped for response routing.
        expect(approvals).toEqual([{ approvalId: 'approval-1', toolName: 'bash' }])
        const approvalRpcId = projector.approvalRpcId('approval-1')
        expect(approvalRpcId).toBeDefined()

        // Usage + native journal persisted.
        expect(messages.some((m) => m.type === 'usage')).toBe(true)
        const nativeTypes = messages.filter((m) => m.type === 'dsh_native').map((m) => m.event.type)
        expect(nativeTypes).toContain('tool/call')
        expect(nativeTypes).toContain('turn/end')

        // dshSeq anchors present for fork-at-message.
        const anchored = messages.find((m) => m.type === 'text' && m.dshSeq !== undefined)
        expect(anchored?.dshSeq).toBe(7)

        // Interrupt (cancel) round-trips.
        await client.cancel('s1')
        interruptSent = true

        ac.abort()
        await pump
        await handle.stop({ timeoutMs: 3_000 })
        expect(interruptSent).toBe(true)
        expect(snapshots.length).toBeGreaterThan(0)
    })
})
