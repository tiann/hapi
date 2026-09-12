import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PreviewTunnel, type PreviewSocketAdapter, type PreviewTerminator } from './tunnelClient'
import { PreviewMountManager, type PreviewSocketAdapter as RegistrySocketAdapter } from './mountManager'
import type { PreviewFrame } from '@hapi/protocol/preview'

const MOUNT_ID = '5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b'
const tempSite = mkdtempSync(join(tmpdir(), 'hapi-preview-mgr-'))

function makeSocket(connected = true): { adapter: PreviewSocketAdapter & RegistrySocketAdapter; sent: PreviewFrame[]; setConnected: (value: boolean) => void; register: (ack: unknown) => void } {
    const sent: PreviewFrame[] = []
    let isConnected = connected
    let registerAck: unknown = null
    const setConnected = (value: boolean) => {
        isConnected = value
    }
    const register = (ack: unknown) => {
        registerAck = ack
    }
    const adapter = {
        connected: () => isConnected,
        emitFrame: (frame: PreviewFrame) => {
            if (!isConnected) return false
            sent.push(frame)
            return true
        },
        register: async () => registerAck as never,
        unregister: async () => ({ ok: true })
    }
    return { adapter: adapter as PreviewSocketAdapter & RegistrySocketAdapter, sent, setConnected, register }
}

function openFrame() {
    return {
        type: 'open' as const,
        connId: 'c1',
        mountId: MOUNT_ID,
        kind: 'http' as const,
        method: 'GET',
        path: '',
        headers: {}
    }
}

describe('PreviewTunnel', () => {
    it('routes open frames to the terminator and data/close to its handlers', () => {
        const { adapter, sent } = makeSocket()
        const tunnel = new PreviewTunnel(adapter)
        const onData = vi.fn()
        const onClose = vi.fn()
        const terminator: PreviewTerminator = (_frame, sink) => {
            sink.respond({ status: 200, headers: { 'content-type': 'text/plain' } })
            return { onData, onClose }
        }

        tunnel.acceptOpen(openFrame(), terminator)

        expect(sent).toEqual([
            { type: 'response', connId: 'c1', status: 200, headers: { 'content-type': 'text/plain' } }
        ])

        tunnel.handleFrame({ type: 'data', connId: 'c1', seq: 0, payload: new Uint8Array([1]) })
        expect(onData).toHaveBeenCalledWith(expect.any(Uint8Array))

        tunnel.handleFrame({ type: 'close', connId: 'c1' })
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('splits large payloads into ≤256 KiB frames with a monotonic seq', () => {
        const { adapter, sent } = makeSocket()
        const tunnel = new PreviewTunnel(adapter)
        const terminator: PreviewTerminator = (_frame, sink) => {
            sink.respond({ status: 200, headers: {} })
            sink.data(new Uint8Array(300 * 1024))
            sink.end()
        }

        tunnel.acceptOpen(openFrame(), terminator)

        const dataFrames = sent.filter((frame) => frame.type === 'data')
        expect(dataFrames).toHaveLength(2)
        expect((dataFrames[0] as { seq: number }).seq).toBe(0)
        expect((dataFrames[1] as { seq: number }).seq).toBe(1)
        expect(sent.at(-1)?.type).toBe('end')
    })

    it('drops unknown conns with a close frame (except for close itself)', () => {
        const { adapter, sent } = makeSocket()
        const tunnel = new PreviewTunnel(adapter)

        // Unknown conn, non-close → close emitted.
        tunnel.handleFrame({ type: 'data', connId: 'zz', seq: 0, payload: new Uint8Array(0) })
        expect(sent).toEqual([{ type: 'close', connId: 'zz' }])

        // Unknown conn, close → no reply loop.
        sent.length = 0
        tunnel.handleFrame({ type: 'close', connId: 'zz' })
        expect(sent).toEqual([])
    })

    it('fails all live conns when the socket drops', () => {
        const { adapter } = makeSocket()
        const tunnel = new PreviewTunnel(adapter)
        const onClose = vi.fn()
        tunnel.acceptOpen(openFrame(), () => ({ onClose }))

        tunnel.failAll('socket disconnected')
        expect(onClose).toHaveBeenCalledOnce()
        expect(tunnel.connCount).toBe(0)
    })

    it('marks conns dead when emitFrame reports a disconnected socket', () => {
        const { adapter, setConnected, sent } = makeSocket(false)
        const tunnel = new PreviewTunnel(adapter)
        const terminator: PreviewTerminator = (_frame, sink) => {
            sink.respond({ status: 200, headers: {} })
        }
        tunnel.acceptOpen(openFrame(), terminator)
        expect(sent).toEqual([])
        expect(tunnel.connCount).toBe(0)
        setConnected(true)
    })
})

describe('PreviewMountManager', () => {
    let socket: ReturnType<typeof makeSocket>

    beforeEach(() => {
        socket = makeSocket()
        socket.register({ ok: true, url: 'http://hub/preview/x/', mountId: MOUNT_ID, expiresAt: Date.now() + 60_000 })
    })

    it('registers a static mount and keeps the same mountId on refresh', async () => {
        const manager = new PreviewMountManager(socket.adapter)
        const mount = await manager.mountStatic({ path: tempSite })
        expect(mount.kind).toBe('static')
        expect(mount.name).toMatch(/hapi-preview-mgr/)

        const again = await manager.mountStatic({ path: tempSite })
        expect(again.mountId).toBe(mount.mountId)
    })

    it('rejects relative paths and non-directories', async () => {
        const manager = new PreviewMountManager(socket.adapter)
        await expect(manager.mountStatic({ path: 'relative/path' })).rejects.toThrow('absolute')
        await expect(manager.mountStatic({ path: '/proc/self/nonexistent-dir-xyz' })).rejects.toThrow('not a directory')
    })

    it('rejects proxy mounts without exactly one of port/url, and non-loopback urls', async () => {
        const manager = new PreviewMountManager(socket.adapter)
        await expect(manager.mountProxy({})).rejects.toThrow('exactly one')
        await expect(manager.mountProxy({ port: 5173, url: 'http://localhost:5173' })).rejects.toThrow('exactly one')
        await expect(manager.mountProxy({ url: 'http://192.168.1.5:3000' })).rejects.toThrow('loopback')
        const mount = await manager.mountProxy({ port: 5173 })
        expect(mount.port).toBe(5173)
        expect(mount.ws).toBe(true)
    })

    it('stop removes by name and all removes everything', async () => {
        const manager = new PreviewMountManager(socket.adapter)
        await manager.mountStatic({ path: tempSite, name: 'a' })
        await manager.mountProxy({ port: 3000, name: 'b' })

        expect(await manager.stop({ name: 'a' })).toBe(1)
        expect(await manager.stop({ all: true })).toBe(1)
        expect(manager.size).toBe(0)
    })

    it('reregisterAll keeps mountIds so URLs survive reconnects', async () => {
        const manager = new PreviewMountManager(socket.adapter)
        const mount = await manager.mountStatic({ path: tempSite, name: 'a' })
        await manager.reregisterAll()

        expect(manager.get('a')?.mountId).toBe(mount.mountId)
    })

    it('reregisterAll drops expired mounts instead of republishing them', async () => {
        // Ack with an already-past expiry — the hub would reject it, but the
        // CLI must not even ask: reviving an expired URL needs a new approval.
        socket.register({ ok: true, url: 'http://hub/preview/x/', mountId: MOUNT_ID, expiresAt: Date.now() - 60_000 })
        const manager = new PreviewMountManager(socket.adapter)
        await manager.mountStatic({ path: tempSite, name: 'a' })
        expect(manager.size).toBe(1)

        await manager.reregisterAll()

        expect(manager.size).toBe(0)
        expect(manager.get('a')).toBeUndefined()
    })

    it('reports a friendly error when the ack times out', async () => {
        socket.register(null)
        const manager = new PreviewMountManager(socket.adapter)
        await expect(manager.mountStatic({ path: tempSite })).rejects.toThrow('timed out')
    })
})
