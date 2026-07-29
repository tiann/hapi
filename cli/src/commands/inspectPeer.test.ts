import { describe, expect, it } from 'vitest'
import { PingPeerError } from '@/modules/pingPeer/pingPeer'
import { parseInspectPeerArgs } from './inspectPeer'

describe('parseInspectPeerArgs', () => {
    it('parses session id and optional limit', () => {
        expect(parseInspectPeerArgs(['7d55ed21-8a9f-4309-b4f8-30069df36b4b', '--limit', '20'])).toEqual({
            help: false,
            sessionIdPrefix: '7d55ed21-8a9f-4309-b4f8-30069df36b4b',
            messageLimit: 20
        })
    })

    it('parses --limit= form and help', () => {
        expect(parseInspectPeerArgs(['--help'])).toEqual({ help: true })
        expect(parseInspectPeerArgs(['aaaa', '--limit=5']).messageLimit).toBe(5)
    })

    it('rejects unknown flags', () => {
        expect(() => parseInspectPeerArgs(['aaaa', '--resume'])).toThrow(PingPeerError)
    })
})
