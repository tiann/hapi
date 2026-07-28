import { describe, expect, it } from 'vitest'
import { PingPeerError } from '@/modules/pingPeer/pingPeer'
import { parsePingPeerArgs } from './pingPeer'

describe('parsePingPeerArgs', () => {
    it('parses positional prefix + message', () => {
        expect(parsePingPeerArgs(['05d9f0f2', 'hello'])).toEqual({
            help: false,
            list: false,
            sessionIdPrefix: '05d9f0f2',
            message: 'hello'
        })
    })

    it('parses --message-file and --wait', () => {
        expect(parsePingPeerArgs(['abc', '--message-file', 'brief.md', '--wait', '30'])).toEqual({
            help: false,
            list: false,
            sessionIdPrefix: 'abc',
            messageFile: 'brief.md',
            waitActiveSecs: 30
        })
    })

    it('parses --list and --help', () => {
        expect(parsePingPeerArgs(['--list'])).toEqual({ help: false, list: true })
        expect(parsePingPeerArgs(['--help']).help).toBe(true)
    })

    it('rejects unknown flags', () => {
        expect(() => parsePingPeerArgs(['--host', 'evil'])).toThrow(PingPeerError)
    })
})
