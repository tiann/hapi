import { afterEach, describe, expect, it, vi } from 'vitest'

const { initializeTokenMock, pingPeerMock } = vi.hoisted(() => ({
    initializeTokenMock: vi.fn(async () => {}),
    pingPeerMock: vi.fn()
}))

vi.mock('@/modules/pingPeer/pingPeer', async () => {
    const actual = await vi.importActual<typeof import('@/modules/pingPeer/pingPeer')>(
        '@/modules/pingPeer/pingPeer'
    )
    return { ...actual, pingPeer: pingPeerMock }
})

vi.mock('@/ui/tokenInit', async () => {
    const actual = await vi.importActual<typeof import('@/ui/tokenInit')>('@/ui/tokenInit')
    return { ...actual, initializeToken: initializeTokenMock }
})

import { PingPeerError } from '@/modules/pingPeer/pingPeer'
import { parsePingPeerArgs, pingPeerCommand } from './pingPeer'

afterEach(() => {
    initializeTokenMock.mockClear()
    pingPeerMock.mockReset()
    vi.restoreAllMocks()
})

describe('parsePingPeerArgs', () => {
    it('parses positional session id + message', () => {
        expect(parsePingPeerArgs(['05d9f0f2-9273-4137-933c-07459a1146a2', 'hello'])).toEqual({
            help: false,
            json: false,
            sessionId: '05d9f0f2-9273-4137-933c-07459a1146a2',
            message: 'hello'
        })
    })

    it('parses --message-file and --wait', () => {
        expect(parsePingPeerArgs([
            'abc', '--message-file', 'brief.md', '--wait', '30',
            '--remit-id', '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'
        ])).toEqual({
            help: false,
            json: false,
            sessionId: 'abc',
            messageFile: 'brief.md',
            remitId: '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c',
            waitActiveSecs: 30
        })
    })

    it('parses --json and --help', () => {
        expect(parsePingPeerArgs(['--json'])).toEqual({ help: false, json: true })
        expect(parsePingPeerArgs(['--help']).help).toBe(true)
    })

    it('rejects unknown flags', () => {
        expect(() => parsePingPeerArgs(['--host', 'evil'])).toThrow(PingPeerError)
        expect(() => parsePingPeerArgs(['--wait', '--json'])).toThrow(PingPeerError)
        expect(() => parsePingPeerArgs(['--remit-id='])).toThrow(PingPeerError)
    })

    it('includes the retryable remit id in JSON after a lost response', async () => {
        const remitId = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'
        pingPeerMock.mockRejectedValueOnce(new PingPeerError('send_failed', 'send failed: socket reset', remitId))
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit:${code}`)
        })

        await expect(pingPeerCommand.run({
            args: [],
            subcommand: 'ping-peer',
            commandArgs: ['--json', '05d9f0f2-9273-4137-933c-07459a1146a2', 'hello']
        })).rejects.toThrow('process.exit:4')
        expect(log).toHaveBeenCalledWith(JSON.stringify({
            ok: false,
            remitId,
            error: { code: 'send_failed', message: 'send failed: socket reset' }
        }))
    })
})
