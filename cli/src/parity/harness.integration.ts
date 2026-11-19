import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { io } from 'socket.io-client'
import { monotonicTimeMs } from '../utils/time'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { claimLaunch, readLaunches } from './launchLog'
import { reached } from './fences'
import { fakeHub, flushState, sid, type Row } from './fakeHub'

it('retains concurrent invocation records when an older process writes last', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parity-launch-'))
    try {
        const first = claimLaunch(dir, 'agent')
        const second = claimLaunch(dir, 'agent')
        second.save({ index: second.index })
        first.save({ index: first.index })
        expect(readLaunches(dir)).toEqual([{ index: 1 }, { index: 2 }])
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

it('holds the step until both documents acknowledge their final writes', () => {
    const rows: Row[] = [{ event: 'message', connection: 1, step: 1, args: ['ready'], ackRequested: false }]
    const fences = [{ event: 'message' }, { event: 'update-state', count: 2, result: 'success' }, { event: 'update-metadata', result: 'success' }]
    const update = { ...rows[0], event: 'update-state', ackRequested: true, ack: [{ result: 'success' }] }
    rows.push(update, update, { ...update, event: 'update-metadata', ack: undefined })
    expect(reached(rows, fences)).toBe(false)
    rows.at(-1)!.ack = [{ result: 'version-mismatch' }]
    expect(reached(rows, fences)).toBe(false)
    rows.push({ ...update, event: 'update-metadata' })
    expect(reached(rows, fences)).toBe(true)
})

it('distinguishes a flush before session end, before archive, and before the write acknowledgement', () => {
    const rows: Row[] = []
    const snapshot = (archived: boolean) => flushState(rows, 1, archived)
    expect(snapshot(false)).toEqual({ sessionEnded: false, archived: false, pendingWrites: 0 })
    rows.push({ connection: 1, step: 1, event: 'session-end', args: [], ackRequested: false })
    expect(snapshot(false)).toEqual({ sessionEnded: true, archived: false, pendingWrites: 0 })
    rows.push({ connection: 1, step: 1, event: 'update-metadata', args: [], ackRequested: true })
    expect(snapshot(true)).toEqual({ sessionEnded: true, archived: true, pendingWrites: 1 })
    rows[1].ack = [{ result: 'success' }]
    expect(snapshot(true)).toEqual({ sessionEnded: true, archived: true, pendingWrites: 0 })
})

it('sends a preparation lease valid across a one-second host clock difference', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parity-lease-'))
    const hub = await fakeHub(dir)
    const socket = io('http://127.0.0.1:' + hub.port + '/cli', { transports: ['websocket'], autoConnect: false })
    try {
        const connected = new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve)
            socket.once('connect_error', reject)
        })
        socket.connect()
        await connected
        let expiresAt = 0
        socket.on('rpc-request', (request, ack) => {
            expiresAt = JSON.parse(request.params).preparationLease.expiresAt
            ack('{}')
        })
        const dispatch = () => hub.execute({ rpc: 'killSession', params: { prepareOnly: true, preparationLease: { expiresAt: '$leaseExpiry' } } },
            () => {}, { pid: process.pid, marker: '' })
        await expect(dispatch()).rejects.toThrow('not registered')
        const registration = { method: sid + ':killSession' }
        let registrationAcknowledged = false
        socket.emit('rpc-register', registration, () => { registrationAcknowledged = true })
        await socket.timeout(5000).emitWithAck('ping')
        expect(registrationAcknowledged).toBe(false)
        await dispatch()
        socket.emit('rpc-unregister', registration)
        await socket.timeout(5000).emitWithAck('ping')
        await expect(dispatch()).rejects.toThrow('not registered')
        const now = monotonicTimeMs()
        expect(expiresAt).toBeGreaterThan(now + 1000)
        expect(expiresAt).toBeLessThan(now - 1000 + 30_000)
    } finally {
        socket.close()
        await hub.close()
        rmSync(dir, { recursive: true, force: true })
    }
})

it('advances both bootstrap versions exactly once when adopting the stub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parity-adopt-'))
    const hub = await fakeHub(dir)
    try {
        const adopt = async (name: string) => {
            const response = await fetch('http://127.0.0.1:' + hub.port + '/cli/sessions', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ adopt: true, id: sid, tag: 'wrapper', metadata: { name } })
            })
            expect(response.status).toBe(200)
            return response.json()
        }
        expect(await adopt('original')).toMatchObject({ session: { metadataVersion: 2, agentStateVersion: 2, seq: 1 } })
        expect(await adopt('retry')).toMatchObject({
            session: { metadataVersion: 2, agentStateVersion: 2, seq: 1, metadata: { name: 'original' } }
        })
    } finally {
        await hub.close()
        rmSync(dir, { recursive: true, force: true })
    }
})

it('acknowledges the runner webhook', async () => {
    const script = fileURLToPath(new URL('./fakes/runner.ts', import.meta.url))
    const runner = spawn('bun', [script], { stdio: ['pipe', 'pipe', 'inherit'] })
    const lines = createInterface({ input: runner.stdout })
    try {
        const [line] = await once(lines, 'line')
        const { port } = JSON.parse(line)
        runner.stdin.end('connected\n')
        const url = 'http://127.0.0.1:' + port + '/session-started'
        expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(415)
        const response = await fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'test', metadata: {} })
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ status: 'ok' })
    } finally {
        lines.close()
        runner.kill()
    }
})
