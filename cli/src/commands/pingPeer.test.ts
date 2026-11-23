import { afterEach, describe, expect, it, vi } from 'vitest'
import * as peerMessages from '@/modules/pingPeer/pingPeer'
import { PingPeerError } from '@/modules/pingPeer/pingPeer'
import * as tokenInit from '@/ui/tokenInit'
import { handlePingPeerCommand, parsePingPeerArgs } from './pingPeer'

describe('parsePingPeerArgs', () => {
    it('parses positional prefix + message', () => {
        expect(parsePingPeerArgs(['05d9f0f2', 'hello'])).toEqual({
            help: false,
            list: false,
            all: false,
            wake: false,
            sessionIdPrefix: '05d9f0f2',
            message: 'hello'
        })
    })

    it('parses --message-file and --wait', () => {
        expect(parsePingPeerArgs(['abc', '--message-file', 'brief.md', '--wait', '30'])).toEqual({
            help: false,
            list: false,
            all: false,
            wake: false,
            sessionIdPrefix: 'abc',
            messageFile: 'brief.md',
            waitActiveSecs: 30
        })
    })

    it('parses --list and --help', () => {
        expect(parsePingPeerArgs(['--list'])).toEqual({ help: false, list: true, all: false, wake: false })
        expect(parsePingPeerArgs(['--list', '--all']).all).toBe(true)
        expect(parsePingPeerArgs(['--help']).help).toBe(true)
    })

    it('parses --wake as an explicit opt-in', () => {
        expect(parsePingPeerArgs(['abc', 'hello']).wake).toBe(false)
        expect(parsePingPeerArgs(['abc', 'hello', '--wake']).wake).toBe(true)
    })

    it('rejects unknown flags', () => {
        expect(() => parsePingPeerArgs(['--host', 'evil'])).toThrow(PingPeerError)
    })

    it.each(['auto', 'queue', 'steer'] as const)('parses delivery mode %s in both flag forms', (mode) => {
        for (const flags of [['--delivery-mode', mode], [`--delivery-mode=${mode}`]]) {
            expect(parsePingPeerArgs(['abc', 'hello', ...flags]).deliveryMode).toBe(mode)
        }
    })

    it.each([
        ['--delivery-mode'],
        ['--delivery-mode='],
        ['--delivery-mode', 'interrupt'],
        ['--delivery-mode', '--list'],
        ['--delivery-mode', 'queue', '--delivery-mode=steer']
    ])('rejects invalid or repeated delivery flags: %j', (...flags) => {
        expect(() => parsePingPeerArgs(['abc', 'hello', ...flags])).toThrow(PingPeerError)
    })
})

describe('handlePingPeerCommand receipts', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it.each([
        [undefined, 'accepted'],
        [undefined, 'steered'],
        ['auto', 'accepted'],
        ['auto', 'steered'],
        ['auto', 'invoked'],
        ['queue', 'accepted'],
        ['steer', 'steered'],
        ['steer', 'invoked']
    ] as const)('forwards mode %s and reports %s with the peer identity', async (deliveryMode, delivery) => {
        vi.spyOn(tokenInit, 'initializeToken').mockResolvedValue(undefined)
        const ping = vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({
            sessionId: 'peer-id', name: 'Peer', resumed: false,
            localId: 'ping-peer-test', delivery
        })
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})

        await handlePingPeerCommand([
            'peer-id', 'hello', ...(deliveryMode ? ['--delivery-mode', deliveryMode] : [])
        ])

        expect(ping).toHaveBeenCalledWith(expect.objectContaining({
            sessionIdPrefix: 'peer-id', message: 'hello', deliveryMode
        }))
        expect(log).toHaveBeenCalledTimes(1)
        expect(log).toHaveBeenCalledWith(expect.stringContaining(delivery === 'accepted'
            ? 'OK - accepted for peer-id localId=ping-peer-test — delivery shows in the recipient chat when its runtime consumes it'
            : `OK - ${delivery} to peer-id localId=ping-peer-test`))
    })

    it.each([
        'steer not attempted: target is idle',
        'steer rejected by hub: Session not found',
        'steer not confirmed; delivery unresolved: Steer outcome is being reconciled'
    ])('appends the auto steer note to an accepted receipt: %s', async (steerNote) => {
        vi.spyOn(tokenInit, 'initializeToken').mockResolvedValue(undefined)
        vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({
            sessionId: 'peer-id', name: 'Peer', resumed: false,
            localId: 'ping-peer-test', delivery: 'accepted', steerNote
        })
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})

        await handlePingPeerCommand(['peer-id', 'hello'])

        expect(log).toHaveBeenCalledWith(expect.stringContaining(
            `consumes it (${steerNote})`))
        expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/no message sent/i))
    })
})

describe('ping-peer help', () => {
    afterEach(() => vi.restoreAllMocks())

    it('includes remote Claude and OpenCode in the explicit steer contract', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        await handlePingPeerCommand(['--help'])
        expect(log).toHaveBeenCalledWith(expect.stringContaining('remote Claude, Pi, Codex'))
        expect(log).toHaveBeenCalledWith(expect.stringContaining('Codex, OpenCode,'))
    })
})
